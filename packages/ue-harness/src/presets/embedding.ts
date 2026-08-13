/**
 * Issue 011 — ONNX Embedding 服务
 *
 * 本地推理 all-MiniLM-L6-v2（sentence-transformers），计算文本的 384-dim 语义向量。
 * 复用预设的 embedding 缓存，供混合检索的 embedding scorer 使用。
 *
 * 关键设计:
 *   - preset embedding 在 syncPresets() 时预计算（async，一次性）
 *   - query embedding 在 matchPresets() 时计算一次（async）
 *   - cosine 相似度是纯同步查表，故 PresetScorer 保持同步签名
 */
import { InferenceSession, Tensor } from "onnxruntime-node";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { PresetEntry, PresetQuery } from "./types.ts";

const HIDDEN = 384;
const MAX_LEN = 128;

// WordPiece 特殊 token id（MiniLM 固定）
const CLS = 101;
const SEP = 102;
const PAD = 0;
const UNK = 100;

export class EmbeddingService {
	private session: InferenceSession | null = null;
	private vocab: Record<string, number> = {};
	private presetVectors = new Map<string, Float32Array>();
	private modelDir: string;

	constructor(modelDir?: string) {
		this.modelDir = modelDir ?? join(homedir(), ".pi", "models", "all-MiniLM-L6-v2");
	}

	get isInitialized(): boolean {
		return this.session !== null;
	}

	/** 加载 tokenizer.json + model.onnx（session_start 时调用一次） */
	async initialize(): Promise<void> {
		const tokenizerPath = join(this.modelDir, "tokenizer.json");
		const modelPath = join(this.modelDir, "onnx", "model.onnx");

		if (!existsSync(tokenizerPath) || !existsSync(modelPath)) {
			throw new Error(
				`[ue-harness] Embedding model not found at ${this.modelDir}. ` +
					`Download Xenova/all-MiniLM-L6-v2 (model.onnx + tokenizer.json) first.`,
			);
		}

		const tokenizer = JSON.parse(readFileSync(tokenizerPath, "utf-8"));
		this.vocab = tokenizer.model.vocab;
		this.session = await InferenceSession.create(modelPath);
	}

	/** 同步所有 preset 的 embedding 向量（session_start / preset 变更时调用） */
	async syncPresets(presets: PresetEntry[]): Promise<void> {
		this.presetVectors.clear();
		for (const p of presets) {
			const text = `${p.name} ${p.description} ${p.tags.join(" ")}`;
			this.presetVectors.set(p.name, await this.embed(text));
		}
	}

	/** 更新单个 preset 的向量（save_preset 后） */
	async upsertPreset(preset: PresetEntry): Promise<void> {
		const text = `${preset.name} ${preset.description} ${preset.tags.join(" ")}`;
		this.presetVectors.set(preset.name, await this.embed(text));
	}

	/** 删除 preset 的向量 */
	removePreset(name: string): void {
		this.presetVectors.delete(name);
	}

	/** 计算 query 的 embedding 向量（matchPresets 里 async 调用一次） */
	async embedQuery(query: PresetQuery): Promise<Float32Array> {
		return this.embed(`${query.description} ${query.tags.join(" ")}`);
	}

	/** 同步查 preset 向量（cosine 用） */
	getPresetVector(name: string): Float32Array | undefined {
		return this.presetVectors.get(name);
	}

	// ── 内部: 文本 → 384-dim L2 归一化向量 ──

	private async embed(text: string): Promise<Float32Array> {
		if (!this.session) throw new Error("EmbeddingService not initialized");

		const { ids, mask, typeIds } = this.encode(text);
		const len = ids.length;

		const feeds = {
			input_ids: new Tensor("int64", BigInt64Array.from(ids.map((x) => BigInt(x))), [1, len]),
			attention_mask: new Tensor("int64", BigInt64Array.from(mask.map((x) => BigInt(x))), [1, len]),
			token_type_ids: new Tensor("int64", BigInt64Array.from(typeIds.map((x) => BigInt(x))), [1, len]),
		};

		const output = await this.session.run(feeds);
		const hiddenName =
			this.session.outputNames.find((n) => n.includes("last_hidden")) ??
			this.session.outputNames[0];
		const lastHidden = output[hiddenName].data as Float32Array;

		// mean pooling（考虑 attention_mask）
		const vec = new Float32Array(HIDDEN);
		let maskSum = 0;
		for (let i = 0; i < len; i++) {
			if (mask[i] === 0) continue;
			maskSum++;
			for (let j = 0; j < HIDDEN; j++) {
				vec[j] += lastHidden[i * HIDDEN + j];
			}
		}
		for (let j = 0; j < HIDDEN; j++) vec[j] /= maskSum || 1;

		// L2 normalize
		let norm = 0;
		for (let j = 0; j < HIDDEN; j++) norm += vec[j] * vec[j];
		norm = Math.sqrt(norm) || 1;
		for (let j = 0; j < HIDDEN; j++) vec[j] /= norm;
		return vec;
	}

	// ── WordPiece tokenizer ──

	/** 文本 → input_ids / attention_mask / token_type_ids（pad 到 MAX_LEN） */
	private encode(text: string): { ids: number[]; mask: number[]; typeIds: number[] } {
		const ids = [CLS, ...this.tokenize(text), SEP].slice(0, MAX_LEN);
		const mask = ids.map(() => 1);
		const typeIds = ids.map(() => 0);
		while (ids.length < MAX_LEN) {
			ids.push(PAD);
			mask.push(0);
			typeIds.push(0);
		}
		return { ids, mask, typeIds };
	}

	private tokenize(text: string): number[] {
		// BertNormalizer: lowercase + trim
		const t = text.toLowerCase().trim();
		// BertPreTokenizer: 按空格 + 标点分词
		const words = t
			.split(/\s+/)
			.flatMap((w) => w.split(/([.,!?;:()\[\]{}"'_-])/g))
			.filter((x) => x.length > 0);

		const ids: number[] = [];
		for (const word of words) {
			// WordPiece 最长匹配
			let start = 0;
			while (start < word.length) {
				let end = word.length;
				let found: number | null = null;
				while (start < end) {
					const sub = (start === 0 ? "" : "##") + word.slice(start, end);
					if (sub in this.vocab) {
						found = this.vocab[sub];
						break;
					}
					end--;
				}
				if (found === null) {
					ids.push(UNK);
					break;
				}
				ids.push(found);
				start = end;
			}
		}
		return ids;
	}
}

/** cosine similarity（两个向量均已 L2 归一化时，等于 dot product） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}
