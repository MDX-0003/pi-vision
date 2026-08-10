/**
 * Issue 007 — tool_call block 规则引擎
 *
 * 在每次 LLM 工具调用前检查:
 *   · 硬上限 (assess/check 次数、further 连续上限、unchanged 轮数)
 *   · Phase 约束 (SETUP 阶段禁止调参, POSTPROCESS_SETUP 禁止截图)
 *   · Tier 门控 (阻塞维度 + 跨 Tier 拦截)
 *   · further 阶段 2 拦截
 *   · artificiality 响应
 */
import type { PhaseState } from "./phase-machine.ts";
import { checkLimits } from "./phase-machine.ts";

// ── 工具 → Tier 映射 ──

/** 工具名包含这些关键词 → 属于哪个 Tier */
const TIER_KEYWORDS: Record<string, number> = {
	DirectionalLight: 1,
	SkyLight: 1,
	LightColor: 1,
	lightColor: 1,
	intensity: 1,
	lightSourceAngle: 1,
	temperature: 1,
	SkyAtmosphere: 2,
	ExponentialHeightFog: 2,
	VolumetricCloud: 2,
	fogDensity: 2,
	fogHeightFalloff: 2,
	fogInscatteringColor: 2,
	layerBottomAltitude: 2,
	layerHeight: 2,
	PostProcessVolume: 3,
	whiteTemp: 3,
	colorSaturation: 3,
	colorContrast: 3,
	colorGamma: 3,
	filmSlope: 3,
	filmToe: 3,
	sceneFringeIntensity: 3,
	colorGradingIntensity: 3,
};

/** 截图工具名模式 */
const SCREENSHOT_TOOLS = ["CaptureViewportImage", "CaptureEditorImage", "Screenshot"];

/** 属性写入工具名模式 */
const WRITE_TOOLS = ["set_properties", "set_actor_transform"];

// ── 主入口 ──

export interface GuardResult {
	/** true = 阻止此调用 */
	block: boolean;
	/** 阻止原因 (给 LLM 看) */
	reason?: string;
}

/**
 * 检查工具调用是否应被阻止。
 *
 * @param toolName 工具名 (UE 原始名, 含点号)
 * @param args 工具参数
 * @param state 当前 Phase 状态
 */
export function checkToolCall(toolName: string, args: Record<string, unknown>, state: PhaseState): GuardResult {
	// ── 硬上限 ──
	const limit = checkLimits(state);
	if (limit.shouldStop) {
		return { block: true, reason: limit.reason };
	}

	// ── Phase 门控 ──

	// SETUP: 禁止任何写工具调用
	const isWrite = WRITE_TOOLS.some((t) => toolName.includes(t));
	if (state.phase === "SETUP" && isWrite) {
		return {
			block: true,
			reason: "当前 Phase: SETUP。请先调 map_atmosphere() 和 assess_lighting() 了解场景状态，不要直接调参。",
		};
	}

	// SETUP: 禁止截图（assess_lighting 内部会截）
	const isScreenshot = SCREENSHOT_TOOLS.some((t) => toolName.includes(t));
	if (state.phase === "SETUP" && isScreenshot) {
		return {
			block: true,
			reason: "当前 Phase: SETUP。assess_lighting() 内部会自动截图，不需要手动截。",
		};
	}

	// POSTPROCESS_SETUP: 禁止截图
	if (state.phase === "POSTPROCESS_SETUP" && isScreenshot) {
		return {
			block: true,
			reason: "当前 Phase: POSTPROCESS_SETUP。后处理正在初始化（回退默认值），截图无意义。请先设好参数再验证。",
		};
	}

	// ── Tier 门控 ──

	if (isWrite && state.phase === "TUNING") {
		const targetTier = resolveTier(toolName, args);

		// 检查阻塞维度: 跨 Tier 之前必须先解决 blockers
		if (targetTier !== null && targetTier > 1 && state.blockingDimensions.length > 0) {
			return {
				block: true,
				reason:
					`Tier 1 存在阻塞维度: ${state.blockingDimensions.join("; ")}。` +
					"阻塞维度必须先解决才能进入更高 Tier——否则后续调整无效。",
			};
		}

		if (targetTier !== null && targetTier !== state.tier) {
			// 检查前置 Tier 是否还有 unresolved gaps
			const unmet = state.lastGapEntries.filter((e) => e.gap !== "minor" && e.tier < targetTier);

			if (targetTier > state.tier && unmet.length > 0) {
				return {
					block: true,
					reason:
						`当前 Tier ${state.tier}，禁止调 Tier ${targetTier} 的参数。` +
						`前置维度仍有 gap: ${unmet.map((e) => `${e.dimension}(${e.gap})`).join(", ")}。` +
						`请先解决当前 Tier 的 gap 再进入 Tier ${targetTier}。`,
				};
			}
		}

		// check_dimension further 阶段 2: 拦截工具调用
		if (targetTier !== null && state.consecutiveSameDimensionFurther >= 2) {
			return {
				block: true,
				reason:
					`维度 "${state.lastCheckDimension}" 连续 ${state.consecutiveSameDimensionFurther} 次 further。` +
					"可能原因: (1) 调整方向持续错误 (2) 受阻塞维度影响 (3) 调整量太小。" +
					"请回退此维度的改动，然后选择上述任一排查方向。",
			};
		}
	}

	// ── artificiality 响应 ──

	if (state.artificialityDetected && isWrite) {
		const isPostProcess = resolveTier(toolName, args) === 3;
		if (isPostProcess) {
			return {
				block: true,
				reason:
					"检测到人工后期感——当前画面的暖调可能来自 PostProcess 滤镜而非真实光源。" +
					"禁止调整 PostProcess color grading 参数。请先回退 PostProcess 到默认值，然后从 DirectionalLight 的光源属性开始调整。",
			};
		}
	}

	return { block: false };
}

// ── Tier 解析 ──

function resolveTier(toolName: string, args: Record<string, unknown>): number | null {
	// 从工具名中推断
	for (const [keyword, tier] of Object.entries(TIER_KEYWORDS)) {
		if (toolName.includes(keyword)) return tier;
	}
	// 从参数中推断 (refPath 或 property name)
	const refPath = typeof args?.instance === "object" && (args.instance as any)?.refPath;
	if (typeof refPath === "string") {
		for (const [keyword, tier] of Object.entries(TIER_KEYWORDS)) {
			if (refPath.includes(keyword)) return tier;
		}
	}
	// 从 values JSON 中推断
	const values = args?.values;
	if (typeof values === "string") {
		for (const [keyword, tier] of Object.entries(TIER_KEYWORDS)) {
			if (values.includes(keyword)) return tier;
		}
	}
	return null;
}
