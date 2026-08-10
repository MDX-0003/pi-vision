/**
 * Issue 007 — before_agent_start 上下文注入
 *
 * 根据当前 Phase/Tier 状态生成 system prompt 追加文本。
 * 告诉 LLM 当前处于什么阶段、可以做什么、禁止做什么。
 *
 * 2026-08-10 重构: gap 摘要改为按 Tier 分组的维度明细表 (量化数字 + 方向描述);
 * 新增阻塞维度摘要 + check_dimension further 三阶段引导。
 */

import type { GapEntry, PhaseState } from "./phase-machine.ts";
import { getDimensionTrends, getFurtherStage, isTierOneSettled } from "./phase-machine.ts";

// ── Phase 模板 ──

const PHASE_TEMPLATES: Record<string, (s: PhaseState) => string> = {
	SETUP: (_s) => `
## 当前阶段: SETUP (初始化)

你必须严格按以下顺序操作:
  1. 调 map_atmosphere() 了解场景中有哪些可调的光照参数
  2. 调 assess_lighting(reference_path) 对比参考图，了解每个维度的差距

禁止在 SETUP 阶段直接调参或截图——这些操作会被自动阻止。
`,

	TUNING: (s) => {
		const furtherStage = getFurtherStage(s);

		let furtherGuidance = "";
		if (furtherStage === 1) {
			furtherGuidance = `
注意: check_dimension 返回 further (维度: ${s.lastCheckDimension || "?"})。
当前方向可能反了，请尝试反向调整，或检查是否受阻塞维度影响。`;
		} else if (furtherStage === 2) {
			furtherGuidance = `
[ACTION REQUIRED] check_dimension 连续 2 次 further (维度: ${s.lastCheckDimension || "?"})。
可能原因:
  1. 调整方向持续错误 -- 请尝试反向调整
  2. 受阻塞维度影响 -- 请先解决阻塞维度，再回到此维度
  3. 调整量太小 -- 请增大参数变化幅度
操作: 回退此维度的改动，然后选择上述任一排查方向。`;
		}

		return `
## 当前阶段: TUNING (Tier ${s.tier})

你正在调整 Tier ${s.tier} 的参数。
${s.tier === 1 ? "只能调 DirectionalLight / SkyLight 的属性 (LightColor, intensity, temperature, lightSourceAngle)。" : ""}
${s.tier === 2 ? "只能调 SkyAtmosphere / ExponentialHeightFog / VolumetricCloud 的属性。" : ""}
${s.tier === 3 ? "可以调 PostProcessVolume 的属性 (whiteTemp, colorSaturation, colorContrast 等)。" : ""}

规则:
  - 可以批量修改参数，不需要每改一个就截图
  - 修改完一批参数后，调 check_dimension(reference_path, dimension) 验证方向
  - 当前 Tier 所有维度 gap=minor 后，调 assess_lighting(reference_path) 进入下一 Tier
  - 跨 Tier 调参会自动被阻止${s.unchangedRounds > 0 ? `\n  - 警告: 已连续 ${s.unchangedRounds} 轮 gap 无变化 -- 请考虑换一个参数或维度` : ""}${s.artificialityDetected ? "\n  - 警告: 检测到人工后期感 -- 请回退 PostProcess 到默认值，从真实光源开始调整" : ""}${furtherGuidance}`;
	},

	POSTPROCESS_SETUP: (_s) => `
## 当前阶段: POSTPROCESS_SETUP

后处理 (PostProcessVolume) 初始化。必须严格按以下步骤:

  1. 将 PostProcessVolume 的所有 color grading 参数回退到默认值
     (whiteTemp=6500, colorSaturation=1.0, colorContrast=1.0, colorGamma=1.0 等)
  2. 设 PostProcessVolume 为不可见 (visible=false) 或确保参数为默认值
  3. 设好目标参数后，enable PostProcessVolume
  4. 禁止在步骤 1-2 期间截图——截图会被自动阻止

完成以上步骤后，调 assess_lighting(reference_path) 进入 TUNING Tier 3。
`,

	FINAL: (_s) => `
## 当前阶段: FINAL VERIFICATION

所有 Tier 的调参已完成。现在做最终确认:

  1. 调 assess_lighting(reference_path) 做最后一次全维度检查
  2. 特别关注 artificiality 字段——如果检测到人工感，需要回退 PostProcess 重新开始

如果所有维度 gap=minor 且无人工感 -> 调参完成。
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

/** 构建 blocker 摘要文本 */
export function buildBlockerSummary(state: PhaseState): string {
	const blockers = state.blockingDimensions;
	if (!blockers || blockers.length === 0) return "";

	let summary = "\n## 阻塞维度 (必须先解决)\n\n";
	for (const b of blockers) {
		summary += `  [BLOCKED] ${b}\n`;
	}
	return summary;
}

/** 构建 gap 摘要文本 (按 Tier 分组的维度明细表) */
export function buildGapSummary(state: PhaseState): string {
	const entries = state.lastGapEntries;
	if (!entries || entries.length === 0) return "";

	const trends = getDimensionTrends(state);

	// 按 Tier 分组
	const tierNames: Record<number, string> = {
		0: "PRIORITY",
		1: "Tier 1 -- CORE_LIGHTING (先解决)",
		2: "Tier 2 -- ATMOSPHERE (Tier 1 完成后才能调)",
		3: "Tier 3 -- POSTPROCESS (Tier 1-2 完成后才能调)",
	};

	const byTier = new Map<number, GapEntry[]>();
	for (const e of entries) {
		const list = byTier.get(e.tier) || [];
		list.push(e);
		byTier.set(e.tier, list);
	}

	let summary = "\n## 当前 Gap 状态\n";

	for (const tier of [0, 1, 2, 3]) {
		const tierEntries = byTier.get(tier);
		if (!tierEntries || tierEntries.length === 0) continue;

		summary += `\n${tierNames[tier] || `Tier ${tier}`}:\n`;
		for (const e of tierEntries) {
			const severityLabel = e.gap === "major" ? "[MAJOR]" : e.gap === "moderate" ? "[MODERATE]" : "[MINOR]";
			let line = `  ${e.dimension.padEnd(20)} ${severityLabel.padEnd(10)} ${e.direction}`;

			// 量化数字 (如果有)
			if (e.quantitative) {
				line += `\n${"".padEnd(35)}ref ${e.quantitative.refValue} -> cur ${e.quantitative.curValue} (delta ${e.quantitative.delta})`;
			}

			// 趋势 (如果有历史数据)
			const trend = trends[e.dimension];
			if (trend) {
				const trendLabel =
					trend.status === "converging"
						? "converging (趋向参考,建议考虑进入下一Tier)"
						: trend.status === "oscillating"
							? "oscillating (方向反复,可能已接近极限)"
							: trend.status === "worsening"
								? "worsening (方向错误,请反向调整)"
								: "stable (无显著变化)";
				line += `\n${"".padEnd(35)}trend: ${trend.history} ${trendLabel}`;
			}

			// Vision 定性描述 (如果有)
			if (e.qualitative) {
				line += `\n${"".padEnd(35)}${e.qualitative}`;
			}

			summary += `${line}\n`;
		}
	}

	// 直方图相关性
	if (state.lastHistogramCorrelation < 1) {
		const corrLabel =
			state.lastHistogramCorrelation < 0.3
				? "低 (画面整体色调分布差异大，检查是否存在结构性不匹配)"
				: state.lastHistogramCorrelation < 0.5
					? "中 (存在整体色调偏差)"
					: "高";
		summary += `\n直方图相关性: ${state.lastHistogramCorrelation.toFixed(2)} (${corrLabel})\n`;
	}

	// 收敛建议: 如果 Tier 1 各维度都已收敛或波动, 提示 LLM 考虑进入下一 Tier
	if (state.phase === "TUNING" && state.tier === 1 && state.assessCount >= 2) {
		if (isTierOneSettled(state)) {
			summary +=
				"\n[Tier 1 各量化维度已基本收敛或波动。继续调 Tier 1 可能收益递减。]\n" +
				"[建议: 调 assess_lighting 确认状态后，考虑进入 Tier 2。]\n";
		}
	}

	if (state.assessCount > 0) {
		summary += `\nassess_lighting: ${state.assessCount}/15  |  check_dimension: ${state.checkCount}/20`;
	}

	return summary;
}
