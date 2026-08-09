/**
 * Issue 005 — before_agent_start 上下文注入
 *
 * 根据当前 Phase/Tier 状态生成 system prompt 追加文本。
 * 告诉 LLM 当前处于什么阶段、可以做什么、禁止做什么。
 */
import type { PhaseState } from "./phase-machine.ts";

// ── Phase 模板 ──

const PHASE_TEMPLATES: Record<string, (s: PhaseState) => string> = {
	SETUP: (_s) => `
## 当前阶段: SETUP (初始化)

你必须严格按以下顺序操作:
  1. 调 map_atmosphere() 了解场景中有哪些可调的光照参数
  2. 调 assess_lighting(reference_path) 对比参考图，了解每个维度的差距

禁止在 SETUP 阶段直接调参或截图——这些操作会被自动阻止。
`,

	TUNING: (s) => `
## 当前阶段: TUNING (Tier ${s.tier})

你正在调整 Tier ${s.tier} 的参数。
${s.tier === 1 ? "只能调 DirectionalLight / SkyLight 的属性 (LightColor, intensity, temperature, lightSourceAngle)。" : ""}
${s.tier === 2 ? "只能调 SkyAtmosphere / ExponentialHeightFog / VolumetricCloud 的属性。" : ""}
${s.tier === 3 ? "可以调 PostProcessVolume 的属性 (whiteTemp, colorSaturation, colorContrast 等)。" : ""}

规则:
  · 可以批量修改参数，不需要每改一个就截图
  · 修改完一批参数后，调 check_dimension(reference_path, dimension) 验证方向
  · 当前 Tier 所有维度 gap=minor 后，调 assess_lighting(reference_path) 进入下一 Tier
  · 跨 Tier 调参会自动被阻止${s.unchangedRounds > 0 ? `\n  ⚠️ 已连续 ${s.unchangedRounds} 轮 gap 无变化——请考虑换一个参数或维度` : ""}
${s.artificialityDetected ? "\n  ⚠️ 检测到人工后期感——请回退 PostProcess 到默认值，从真实光源开始调整" : ""}
`,

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

如果所有维度 gap=minor 且无人工感 → 调参完成。
`,

	DONE: (_s) => `
## 当前阶段: DONE ✅

所有维度的光照氛围已接近参考图。调参流程完成。
`,
};

/** 构建 Phase 上下文文本 */
export function buildPhaseContext(state: PhaseState): string {
	const template = PHASE_TEMPLATES[state.phase];
	if (!template) return "";
	return template(state);
}

/** 构建 gap 摘要文本 */
export function buildGapSummary(state: PhaseState): string {
	const gaps = state.lastGaps;
	if (!gaps || Object.keys(gaps).length === 0) return "";

	const entries = Object.entries(gaps);
	const majors = entries.filter(([, g]) => g === "major");
	const moderates = entries.filter(([, g]) => g === "moderate");
	const minors = entries.filter(([, g]) => g === "minor");

	let summary = "\n## 当前 Gap 状态\n\n";
	if (majors.length > 0) summary += `🔴 major: ${majors.map(([d]) => d).join(", ")}\n`;
	if (moderates.length > 0) summary += `🟡 moderate: ${moderates.map(([d]) => d).join(", ")}\n`;
	if (minors.length > 0) summary += `🟢 minor: ${minors.map(([d]) => d).join(", ")}\n`;
	if (state.assessCount > 0)
		summary += `\nassess_lighting: ${state.assessCount}/15 | check_dimension: ${state.checkCount}/20`;

	return summary;
}
