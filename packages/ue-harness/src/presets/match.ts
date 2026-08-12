/**
 * Issue 010a — 预设标签匹配（纯 Jaccard）
 *
 * 纯函数：输入参考图标签 + 所有预设 → 输出排序后的 top-N 匹配。
 * 不调用 Vision API，不做 I/O。
 */

import type { PresetEntry, PresetMatch } from "./types.ts";

// ═══════════════════════════════════════════
// TagScorer 接口（未来可替换为 embedding cosine similarity）
// ═══════════════════════════════════════════

/**
 * 标签打分函数。
 * 当前实现: Jaccard overlap。
 * 未来可替换为 embedding cosine similarity（签名不变，返回 number）。
 */
export type TagScorer = (queryTags: string[], presetTags: string[]) => number;

/**
 * Jaccard 相似度: |A ∩ B| / |A ∪ B|。
 * 两边都为空 → 0。
 */
export function jaccardTagScore(queryTags: string[], presetTags: string[]): number {
	const intersection = queryTags.filter((t) => presetTags.includes(t)).length;
	const union = new Set([...queryTags, ...presetTags]).size;
	return union > 0 ? intersection / union : 0;
}

// ═══════════════════════════════════════════
// 匹配
// ═══════════════════════════════════════════

/**
 * 基于纯 Jaccard overlap 匹配预设。
 *
 * 未来拓展:
 *   - 传入 options.scorer 为 embedding cosine 版本 → 签名不变
 *   - embedding 路径: scorer 内部查 embedding lookup → top-10 → Vision 综合 → top-3
 */
export function matchPresetsByTags(
	queryTags: string[],
	presets: PresetEntry[],
	options?: { scorer?: TagScorer; topN?: number },
): PresetMatch[] {
	const scorer = options?.scorer ?? jaccardTagScore;
	const topN = options?.topN ?? 10;

	const results: PresetMatch[] = [];
	for (const preset of presets) {
		const score = scorer(queryTags, preset.tags);
		if (score > 0) {
			results.push({
				name: preset.name,
				description: preset.description,
				score: Math.round(score * 100) / 100,
				matchedTags: queryTags.filter((t) => preset.tags.includes(t)),
			});
		}
	}

	return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, topN);
}
