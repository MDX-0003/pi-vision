/**
 * Issue 011 — 预设混合检索（Jaccard + BM25 + Embedding → RRF 融合）
 *
 * 替代 Issue 010a 的 matchPresetsByTags。
 * 三个 scorer 并行打分，Reciprocal Rank Fusion 融合排名，输出 top-N。
 *
 * 关键设计:
 *   - PresetScorer 保持同步签名（(query, preset) => number）
 *   - embedding 的推理是 async，故 query embedding 在 matchPresets 里先 await 算一次，
 *     后续 cosine 查表是同步的
 */
import type { PresetEntry, PresetMatch, PresetQuery, PresetScorer } from "./types.ts";
import { cosineSimilarity, type EmbeddingService } from "./embedding.ts";
import type { BM25Index } from "./bm25.ts";

// ═══════════════════════════════════════════
// Scorers
// ═══════════════════════════════════════════

/** Jaccard overlap: |A ∩ B| / |A ∪ B|。纯标签匹配，永远可用。 */
export function jaccardScorer(query: PresetQuery, preset: PresetEntry): number {
	const intersection = query.tags.filter((t) => preset.tags.includes(t)).length;
	const union = new Set([...query.tags, ...preset.tags]).size;
	return union > 0 ? intersection / union : 0;
}

// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// 匹配入口
// ═══════════════════════════════════════════

export interface MatchServices {
	embedding?: EmbeddingService | null;
	bm25?: BM25Index | null;
}

/**
 * 匹配预设：Jaccard + BM25 + Embedding 并行打分 → RRF 融合 → top-N。
 *
 * @param query    参考图查询（tags + description）
 * @param presets  所有预设
 * @param services 已初始化的 embedding / bm25 服务（可选，未提供则只用 Jaccard）
 * @param options.topN 返回数量，默认 5
 */
export async function matchPresets(
	query: PresetQuery,
	presets: PresetEntry[],
	services: MatchServices = {},
	options?: { topN?: number },
): Promise<PresetMatch[]> {
	const topN = options?.topN ?? 5;
	const { embedding, bm25 } = services;

	// 预计算 query embedding（async，一次）
	const queryVec =
		embedding && embedding.isInitialized ? await embedding.embedQuery(query) : null;

	// 组装同步 scorer
	const scorers: Record<string, PresetScorer> = { jaccard: jaccardScorer };
	if (bm25) {
		scorers.bm25 = (q, p) => bm25.score(q, p);
	}
	if (embedding && queryVec) {
		scorers.embedding = (_q, p) => {
			const pv = embedding.getPresetVector(p.name);
			return pv ? cosineSimilarity(queryVec, pv) : 0;
		};
	}

	// 每个 scorer 独立打分 + 排名（只对 score > 0 的候选排名，避免 0 分的噪声排名污染 RRF）
	const scorerRanks: Record<string, Map<string, number>> = {};
	for (const [scorerName, scorer] of Object.entries(scorers)) {
		const scored = presets
			.map((p) => ({ name: p.name, score: scorer(query, p) }))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score);
		const rankMap = new Map<string, number>();
		scored.forEach((s, i) => rankMap.set(s.name, i + 1)); // rank 从 1 开始
		scorerRanks[scorerName] = rankMap;
	}

	// RRF 融合：每个 preset 按"参与 scorer 数"归一化，score ∈ [0, 1]
	//   1 = 所有参与维度都 rank=1；0 = 所有 scorer 均未命中
	const K = 60;
	const fused: PresetMatch[] = presets.map((p) => {
		let sum = 0;
		let count = 0;
		for (const rankMap of Object.values(scorerRanks)) {
			const rank = rankMap.get(p.name);
			if (rank !== undefined) {
				sum += 1 / (K + rank);
				count++;
			}
		}
		const score = count > 0 ? sum / count / (1 / (K + 1)) : 0;
		return {
			name: p.name,
			description: p.description,
			score: Math.round(score * 100) / 100,
		};
	});

	return fused
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, topN);
}
