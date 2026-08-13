/**
 * Issue 009c — before_agent_start 上下文注入
 *
 * 重写: buildAnalysisSummary (替换 buildGapSummary) +
 *       新增: buildQuantitativeTrendSummary +
 *       收尾提示 (tierRoundCount >= 10)
 * 移除: buildBlockerSummary, check_dimension related guidance
 */

import type { QuantitativeSnapshot, PhaseState } from "./phase-machine.ts";
import { TIER_MAX_ROUNDS } from "./phase-machine.ts";
import type { AnalysisEntry } from "../tools/assess-lighting.ts";

// ── Phase 模板 ──

const PHASE_TEMPLATES: Record<string, (s: PhaseState) => string> = {
	SETUP: (_s) => `
## 当前阶段: SETUP (初始化)

你必须严格按以下顺序操作:
  1. 调 map_atmosphere() 了解场景中有哪些可调的光照参数
  2. 调 assess_lighting(reference_path) 对比参考图，了解每个维度的差距

禁止在 SETUP 阶段直接调参或截图——这些操作会被自动阻止。
PostProcess 参数会在首次 assess_lighting 时自动重置到默认值。
`,

	TUNING: (s) => `
## 当前阶段: TUNING (Tier ${s.tier})

你正在调整 Tier ${s.tier} 的参数。
${s.tier === 1 ? "只能调 DirectionalLight / SkyLight 的属性 (LightColor, intensity, temperature, lightSourceAngle)。" : ""}
${s.tier === 2 ? "只能调 SkyAtmosphere / ExponentialHeightFog / VolumetricCloud 的属性。" : ""}
${s.tier === 3 ? "可以调 PostProcessVolume 的属性 (whiteTemp, colorSaturation, colorContrast, colorGamma, autoExposureBias 等)。" : ""}

规则:
  - 可以批量修改参数，不需要每改一个就截图
  - 修改完一批参数后，调 assess_lighting(reference_path) 获取 Vision 综合诊断
  - Vision 的 analysis 中 needs_adjustment 项 = 仍需调参
  - 当前 Tier 所有 aspect close_enough → 自动进入下一 Tier
  - 跨 Tier 调参会自动被阻止${s.tierRoundCount > 0 ? `\n  - 当前 Tier 已进行 ${s.tierRoundCount}/${TIER_MAX_ROUNDS} 轮调参` : ""}`,

	POSTPROCESS_SETUP: (_s) => `
## 当前阶段: POSTPROCESS_SETUP

PostProcess 参数已重置为默认值。继续 TUNING Tier 3。
调 assess_lighting(reference_path) 进入 Tier 3 调参阶段。
`,

	FINAL: (_s) => `
## 当前阶段: FINAL VERIFICATION

所有 Tier 的调参已完成。现在做最终确认:
  调 assess_lighting(reference_path) 做最后一次全维度检查。

如果所有 aspect close_enough → 调参完成。
`,

	DONE: (_s) => `
## 当前阶段: DONE

所有维度的光照氛围已接近参考图。调参流程完成。
`,
};

/** 构建 Phase 上下文文本 */
export function buildPhaseContext(state: PhaseState): string {
	const template = PHASE_TEMPLATES[state.phase];
	if (!template) return "";
	return template(state);
}

// ═══════════════════════════════════════════
// buildAnalysisSummary (替换旧 buildGapSummary)
// ═══════════════════════════════════════════

export function buildAnalysisSummary(state: PhaseState): string {
	const entries = state.lastAnalysis;
	if (!entries || entries.length === 0) return "";

	// 按 Tier 分组
	const byTier = new Map<number, AnalysisEntry[]>();
	for (const e of entries) {
		const list = byTier.get(e.tier) || [];
		list.push(e);
		byTier.set(e.tier, list);
	}

	let summary = "\n## 当前分析状态\n";

	for (const tier of [1, 2, 3]) {
		const tierEntries = byTier.get(tier);
		if (!tierEntries || tierEntries.length === 0) continue;

		summary += `\nTier ${tier}${tier === state.tier ? ` (第 ${state.tierRoundCount}/${TIER_MAX_ROUNDS} 轮)` : ""}:\n`;
		for (const e of tierEntries) {
			const marker = e.status === "needs_adjustment" ? "[needs_adjustment]" : "[close_enough]";
			summary += `  ${marker} ${e.aspect}\n`;

			if (e.suggestion) {
				summary += `    ${e.suggestion}\n`;
			}
		}
	}

	if (state.lastOverall) {
		summary += `\nVision 总评: ${state.lastOverall}\n`;
	}

	summary += `\nassess_lighting: ${state.assessCount}/30`;

	return summary;
}

// ═══════════════════════════════════════════
// 收尾提示 (tierRoundCount >= TIER_MAX_ROUNDS)
// ═══════════════════════════════════════════

function buildWindDownHint(state: PhaseState): string {
	if (state.tierRoundCount < TIER_MAX_ROUNDS) return "";
	if (state.phase !== "TUNING") return "";

	// 检查当前 tier 是否还有 needs_adjustment
	const hasNeedsAdj = state.lastAnalysis.some(
		(a) => a.tier === state.tier && a.status === "needs_adjustment",
	);
	if (!hasNeedsAdj) return "";

	let hint = `\n--\nTier ${state.tier} 已进行 ${TIER_MAX_ROUNDS} 轮调参。\n`;

	if (state.bestRound) {
		hint += `第 ${state.bestRound.assessIndex} 轮曾达到最佳状态 (${state.bestRound.closeEnoughCount}/${state.bestRound.closeEnoughCount + state.bestRound.needsAdjustmentCount} aspects close_enough)。\n`;
	}

	hint += "如当前参数已接近该状态，建议接受现状，停止当前 Tier 调参并关注更高 Tier 的问题。\n";
	return hint;
}

// ═══════════════════════════════════════════
// buildQuantitativeTrendSummary (新增)
// ═══════════════════════════════════════════

function trendLabel(snapshots: QuantitativeSnapshot[], key: (s: QuantitativeSnapshot) => number, isDiff = false): string {
	if (snapshots.length < 2) return "—";

	const oldest = key(snapshots[0]);
	const newest = key(snapshots[snapshots.length - 1]);
	const ratio = oldest !== 0 ? newest / oldest : 1;

	// 连续 3 轮波动 < 5% → 停滞
	if (snapshots.length === 3) {
		const v0 = key(snapshots[0]);
		const v1 = key(snapshots[1]);
		const v2 = key(snapshots[2]);
		const maxVal = Math.max(Math.abs(v0), Math.abs(v1), Math.abs(v2)) || 1;
		const range = (Math.max(v0, v1, v2) - Math.min(v0, v1, v2)) / maxVal;
		if (range < 0.05) return "停滞";
	}

	if (ratio < 0.9) return isDiff ? "改善" : "收敛";
	if (ratio > 1.1) return isDiff ? "恶化" : "扩大";
	return "波动";
}

/**
 * 检测亮度震荡: 最近 3 轮 deltaPct 符号交替且振幅 > 10% → auto-exposure 未稳定。
 */
function luminanceOscillationHint(snapshots: QuantitativeSnapshot[]): string {
	if (snapshots.length < 3) return "";

	const d0 = snapshots[0].luminanceDeltaPct;
	const d1 = snapshots[1].luminanceDeltaPct;
	const d2 = snapshots[2].luminanceDeltaPct;

	// 符号交替: +→-→+ 或 -→+→-
	const signFlip = (d0 > 0 && d1 < 0 && d2 > 0) || (d0 < 0 && d1 > 0 && d2 < 0);
	if (!signFlip) return "";

	// 振幅: max - min > 10%
	const amplitude = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2))
		- Math.min(Math.abs(d0), Math.abs(d1), Math.abs(d2));
	if (amplitude < 10) return "";

	// 找到最佳轮
	let bestIdx = 0;
	let bestAbs = Math.abs(d0);
	for (let i = 1; i < 3; i++) {
		const abs = Math.abs([d0, d1, d2][i]);
		if (abs < bestAbs) { bestAbs = abs; bestIdx = i; }
	}
	const bestIter = snapshots[bestIdx].assessIndex;

	return (
		`[亮度震荡检测] 最近 3 轮亮度 delta% 符号交替 (${d0 >= 0 ? "+" : ""}${d0.toFixed(1)}% → ` +
		`${d1 >= 0 ? "+" : ""}${d1.toFixed(1)}% → ${d2 >= 0 ? "+" : ""}${d2.toFixed(1)}%) -- ` +
		`auto-exposure 可能未稳定。建议回退到第 ${bestIter} 轮 (delta 仅 ${bestAbs.toFixed(1)}%)，等待 3 秒后重新评估。\n`
	);
}

function deltaEHint(snapshots: QuantitativeSnapshot[]): string {
	if (snapshots.length === 0) return "";
	const newest = snapshots[snapshots.length - 1].deltaE_mean;
	const trend = trendLabel(snapshots, (s) => s.deltaE_mean);
	if (newest < 3) {
		return `Delta E mean 降至 ${newest.toFixed(1)} -- 感知阈值约 3，继续微调收益递减。\n`;
	}
	if (newest < 6 && trend === "收敛") {
		return `Delta E mean ${newest.toFixed(1)} -- 仍在感知阈值之上但持续改善。\n`;
	}
	return "";
}

function skyRatioHint(snapshots: QuantitativeSnapshot[]): string {
	if (snapshots.length === 0) return "";
	const newest = snapshots[snapshots.length - 1];
	const groundDeviation = Math.abs(newest.groundLuminanceRatio - 0.6); // rough: ground ~60% of image
	if (newest.skyLuminanceRatio > 0.3 && groundDeviation < 0.15) {
		return `天空区域持续贡献 ~${Math.round(newest.skyLuminanceRatio * 100)}% 全局亮度偏差 -- 全局 brightness 数值受天空主导，不应作为 DirectionalLight 调参唯一依据。\n`;
	}
	return "";
}

export function buildQuantitativeTrendSummary(state: PhaseState): string {
	const snapshots = state.quantitativeSnapshots;
	if (snapshots.length < 2) return "";

	// Build header
	const headers = snapshots.map((s) => `#${s.assessIndex}`).join(" | ");
	let summary = `\n## 定量趋势 (最近 ${snapshots.length} 轮)\n\n`;
	summary += `| 指标 | ${headers} | 趋势 |\n`;
	summary += `|------|${snapshots.map(() => "-----").join("-")}|------|\n`;

	// Luminance delta % (most sensitive to auto-exposure oscillation)
	const lumVals = snapshots.map((s) => `${s.luminanceDeltaPct >= 0 ? "+" : ""}${s.luminanceDeltaPct.toFixed(1)}%`).join(" | ");
	summary += `| 亮度 delta% | ${lumVals} | ${trendLabel(snapshots, (s) => Math.abs(s.luminanceDeltaPct), true)} |\n`;

	// Delta E mean
	const deVals = snapshots.map((s) => s.deltaE_mean.toFixed(1)).join(" | ");
	summary += `| Delta E mean | ${deVals} | ${trendLabel(snapshots, (s) => s.deltaE_mean)} |\n`;

	// Delta E p90
	const dep90Vals = snapshots.map((s) => s.deltaE_p90.toFixed(1)).join(" | ");
	summary += `| Delta E p90 | ${dep90Vals} | ${trendLabel(snapshots, (s) => s.deltaE_p90)} |\n`;

	// Chroma diff
	const chromaVals = snapshots.map((s) => s.chroma_diff.toFixed(1)).join(" | ");
	summary += `| Chroma diff | ${chromaVals} | ${trendLabel(snapshots, (s) => s.chroma_diff, true)} |\n`;

	// Sky luminance ratio
	const skyVals = snapshots.map((s) => `${Math.round(s.skyLuminanceRatio * 100)}%`).join(" | ");
	summary += `| 天空亮度占比 | ${skyVals} | ${trendLabel(snapshots, (s) => s.skyLuminanceRatio)}${snapshots.length === 3 && trendLabel(snapshots, (s) => s.skyLuminanceRatio) === "停滞" ? " -- 天空仍主导" : ""} |\n`;

	// Ground luminance ratio
	const groundVals = snapshots.map((s) => `${Math.round(s.groundLuminanceRatio * 100)}%`).join(" | ");
	summary += `| 地面亮度占比 | ${groundVals} | ${trendLabel(snapshots, (s) => s.groundLuminanceRatio)} |\n`;

	// Histogram correlation
	const histVals = snapshots.map((s) => s.histogramCorrelation.toFixed(2)).join(" | ");
	summary += `| 直方图相关 | ${histVals} | ${trendLabel(snapshots, (s) => s.histogramCorrelation)} |\n`;

	summary += "\n";

	// Luminance oscillation detection
	summary += luminanceOscillationHint(snapshots);

	// Delta E threshold hint
	summary += deltaEHint(snapshots);

	// Sky ratio hint
	summary += skyRatioHint(snapshots);

	return summary;
}

// ═══════════════════════════════════════════
// 注入编排 (提供给 index.ts)
// ═══════════════════════════════════════════

export function buildInjectionAppendix(state: PhaseState): string {
	const parts: string[] = [];

	// Phase context
	const phaseCtx = buildPhaseContext(state);
	if (phaseCtx) parts.push(phaseCtx);

	// Analysis summary
	const analysis = buildAnalysisSummary(state);
	if (analysis) parts.push(analysis);

	// Quantitative trend (assessCount >= 3)
	if (state.assessCount >= 3) {
		const trend = buildQuantitativeTrendSummary(state);
		if (trend) parts.push(trend);
	}

	// Wind-down hint (tierRoundCount >= 10)
	const windDown = buildWindDownHint(state);
	if (windDown) parts.push(windDown);

	return parts.join("\n");
}

// ═══════════════════════════════════════════
// Issue 008c — 预设匹配建议 (保持)
// ═══════════════════════════════════════════

import type { PresetMatch } from "../presets/types.ts";

export function buildPresetSuggestion(matches: PresetMatch[]): string {
	if (!matches || matches.length === 0) return "";

	let text = "\n## 匹配的预设（仅本次 assess 后提示一次）\n\n";
	text += "以下预设与当前参考图氛围相似（综合标签、关键词、语义匹配），可提供调参起点:\n";

	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		text += `  [${i + 1}] ${m.name} (得分 ${m.score})\n`;
		text += `      ${m.description}\n`;
	}

	text += `
如果你认为某个预设比当前默认场景更适合作为起点:
  调 load_preset('name') 批量应用该预设 → 调 assess_lighting() 检验效果

不使用预设则忽略此建议，继续手动调参。
`;
	return text;
}
