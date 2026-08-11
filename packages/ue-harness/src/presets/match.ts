/**
 * Issue 008c — 预设标签匹配
 *
 * 纯函数：输入参考图标签 + 所有预设 → 输出排序后的 top-3 匹配。
 * 不调用 Vision API，不做 I/O。
 */

import { CONTROLLED_DIMENSIONS, type PresetTags } from "../vision/analyzer.ts";
import type { PresetEntry, PresetMatch } from "./types.ts";

/**
 * 基于受控标签 + 自由标签计算预设匹配分。
 *
 * 规则:
 *  - 受控标签: 双方都非 "unspecified" 的维度比较，精确 === 匹配
 *  - 至少 2 个可比维度才计分
 *  - 自由标签: Jaccard 加分（权重 0.15）
 *  - controlledScore >= 0.5 且 hits >= 2 → 候选
 *  - 返回 top-3
 */
export function matchPresetsByTags(
	queryTags: PresetTags,
	queryFreeform: string[],
	presets: PresetEntry[],
): PresetMatch[] {
	const results: PresetMatch[] = [];

	for (const preset of presets) {
		let hits = 0;
		let comparable = 0;
		const matchedDims: string[] = [];

		for (const dim of CONTROLLED_DIMENSIONS) {
			const q = queryTags[dim];
			const p = preset.tags[dim];
			if (q === "unspecified" || p === "unspecified") continue;
			comparable++;
			if (q === p) {
				hits++;
				matchedDims.push(dim);
			}
		}

		if (comparable < 2) continue;

		const controlledScore = hits / comparable;

		const intersection = queryFreeform.filter((t) => preset.freeformTags.includes(t)).length;
		const union = new Set([...queryFreeform, ...preset.freeformTags]).size;
		const freeformScore = union > 0 ? intersection / union : 0;

		const score = controlledScore * 0.85 + freeformScore * 0.15;

		if (score >= 0.5 && hits >= 2) {
			results.push({
				name: preset.name,
				description: preset.description,
				score: Math.round(score * 100) / 100,
				matchedDimensions: matchedDims,
			});
		}
	}

	return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 3);
}
