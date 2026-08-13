/**
 * Issue 009d — tool_call block 规则引擎
 *
 * 清理: 移除 artificiality 拦截 (SETUP 阶段已重置 PostProcess)、
 * 移除 check_dimension/further 相关逻辑。
 * 保留: 硬上限检查、Phase 约束、Tier 门控。
 */
import type { PhaseState } from "./phase-machine.ts";
import { checkLimits } from "./phase-machine.ts";
import { resolveTier } from "./tiers.ts";

// ── 工具 → Tier 映射 ──
// TIER_KEYWORDS / resolveTier 已迁移到 tiers.ts（数据驱动），此处直接用导入的 resolveTier。

/** 截图工具名模式 */
const SCREENSHOT_TOOLS = ["CaptureViewportImage", "CaptureEditorImage", "Screenshot"];

/** 只读工具名模式 —— 不改变场景状态，永远不受硬上限拦截 */
const READONLY_TOOLS = [
	"get_properties",
	"list_properties",
	"get_actor_transform",
	"find_actors",
	"list_toolsets",
	"describe_toolset",
	"get_current_level",
	"get_execution_environment",
	"CaptureViewportImage",
	"Screenshot",
];

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
export function checkToolCall(
	toolName: string,
	_args: Record<string, unknown>,
	state: PhaseState,
): GuardResult {
	// ── 硬上限 (只对写工具生效，只读工具永远放行) ──
	const isReadonly = READONLY_TOOLS.some((t) => toolName.includes(t));
	if (!isReadonly) {
		const limit = checkLimits(state);
		if (limit.shouldStop) {
			return { block: true, reason: limit.reason };
		}
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
			reason: "当前 Phase: POSTPROCESS_SETUP。后处理已重置为默认值，请调 assess_lighting() 进入 Tier 3 调参。",
		};
	}

	// ── Tier 门控 ──

	if (isWrite && state.phase === "TUNING") {
		const targetTier = resolveTier(toolName, _args);

		if (targetTier !== null && targetTier > state.tier) {
			// 检查前置 tier 是否还有 blocking aspects
			const unmet = state.lastAnalysis
				.filter((a) => a.status === "needs_adjustment" && a.tier < targetTier);

			if (unmet.length > 0) {
				return {
					block: true,
					reason:
						`当前 Tier ${state.tier}，禁止调 Tier ${targetTier} 的参数。` +
						`前置维度仍有 needs_adjustment: ${unmet.map((a) => `${a.aspect}`).join(", ")}。` +
						`请先解决当前 Tier 的问题再进入 Tier ${targetTier}。`,
				};
			}
		}
	}

	return { block: false };
}
