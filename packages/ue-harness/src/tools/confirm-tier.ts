/**
 * Issue 012 review — confirm_tier_done 自研工具
 *
 * 背景: LLM 在场景光照方向已达标时, 无法表达"Tier 1 无需调整"——
 * tier 推进只发生在 assess_lighting 的 onAssessLighting 里 (Vision 判定 close_enough)。
 * 若 Vision 仍把当前 tier 的 aspect 标 needs_adjustment, LLM 写更高 tier 会被 guard 拦截,
 * 陷入死锁 (只能等 plateau 兜底浪费轮次)。
 *
 * 方案: 提供显式逃生口。LLM 调 confirm_tier_done(reason) 声明当前 Tier 已完成,
 * 走与机器判定相同的 advanceTier 单入口推进到下一 Tier。reason 记日志可审计。
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getPhaseState } from "../state.ts";
import { confirmTierDone } from "../workflow/phase-machine.ts";

export const confirmTierDoneDef = {
	name: "confirm_tier_done",
	label: "Confirm Tier Done",
	description:
		"声明当前 Tier 的调参已完成（例如光照方向已符合参考图、无需调整），立即推进到下一 Tier。" +
		"仅在确信当前 Tier 无需继续调整时使用；会跳过当前 Tier 的剩余轮次。",
	parameters: Type.Object({
		reason: Type.String(),
	}),
	promptSnippet: "confirm_tier_done: 声明当前 Tier 已完成并推进到下一 Tier",
	promptGuidelines: [
		"当当前 Tier 的 aspect 已达标或你认为无需调整时使用（如方向已匹配参考图）",
		"提供简短 reason 说明判断依据",
	],
};

export async function executeConfirmTierDone(
	params: { reason: string },
): Promise<AgentToolResult<null>> {
	const state = getPhaseState();
	if (!state) {
		return errResult("Phase state not initialized");
	}
	if (state.phase !== "TUNING") {
		return errResult(`当前 Phase: ${state.phase}。confirm_tier_done 仅 TUNING 阶段可用。`);
	}

	const confirmedTier = state.tier;
	confirmTierDone(state, params.reason);

	const note =
		state.phase === "FINAL"
			? "所有 Tier 调参完成，进入 FINAL VERIFICATION。"
			: `已进入 Tier ${state.tier}（${state.phase}）。`;
	const text = JSON.stringify({
		success: true,
		confirmedTier,
		nextTier: state.tier,
		phase: state.phase,
		note,
	});
	return { content: [{ type: "text", text }], details: null };
}

function errResult(msg: string): AgentToolResult<null> {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
		details: null,
	};
}
