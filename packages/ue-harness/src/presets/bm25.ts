/**
 * Issue 011 — BM25 关键词检索
 *
 * 自实现 Okapi BM25，无外部依赖。索引建立于 preset 的 name + description + tags 拼接文本上。
 * 用于混合检索中与 embedding 并行的关键词 scorer。
 */
import type { PresetEntry, PresetQuery } from "./types.ts";

const K1 = 1.5;
const B = 0.75;

/** 简单分词：lowercase + 按空格/标点拆分 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

export class BM25Index {
	// presetName -> (term -> freq)
	private termFreqs = new Map<string, Map<string, number>>();
	// presetName -> doc length
	private docLengths = new Map<string, number>();
	// term -> idf
	private idf = new Map<string, number>();
	private avgDocLength = 0;
	private docNames: string[] = [];

	/** 从 preset 列表建索引（session_start / preset 变更时调用） */
	buildIndex(presets: PresetEntry[]): void {
		this.termFreqs.clear();
		this.docLengths.clear();
		this.idf.clear();
		this.docNames = [];

		// 文档频率（term -> 出现该词的文档数）
		const docFreq = new Map<string, number>();

		for (const p of presets) {
			const text = `${p.name} ${p.description} ${p.tags.join(" ")}`;
			const terms = tokenize(text);

			const tf = new Map<string, number>();
			for (const t of terms) {
				tf.set(t, (tf.get(t) ?? 0) + 1);
			}
			this.termFreqs.set(p.name, tf);
			this.docLengths.set(p.name, terms.length);
			this.docNames.push(p.name);

			// 去重后的 term 计入文档频率
			for (const t of new Set(terms)) {
				docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
			}
		}

		const n = presets.length;
		const totalLen = [...this.docLengths.values()].reduce((a, b) => a + b, 0);
		this.avgDocLength = n > 0 ? totalLen / n : 0;

		// IDF = ln((N - df + 0.5) / (df + 0.5) + 1)
		for (const [term, df] of docFreq) {
			this.idf.set(term, Math.log((n - df + 0.5) / (df + 0.5) + 1));
		}
	}

	/** 计算单个 preset 的 BM25 分数（同步，纯查表） */
	score(query: PresetQuery, preset: PresetEntry): number {
		const docTerms = this.termFreqs.get(preset.name);
		if (!docTerms) return 0;

		const dl = this.docLengths.get(preset.name) ?? 0;
		const queryTerms = tokenize(`${query.description} ${query.tags.join(" ")}`);

		let score = 0;
		for (const term of queryTerms) {
			const idf = this.idf.get(term) ?? 0;
			const tf = docTerms.get(term) ?? 0;
			if (tf === 0) continue;

			const numerator = tf * (K1 + 1);
			const denominator = tf + K1 * (1 - B + (B * dl) / (this.avgDocLength || 1));
			score += idf * (numerator / denominator);
		}
		return score;
	}
}
