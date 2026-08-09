/**
 * Issue 005 — Phase 状态机
 *
 * 维护当前 Phase 和 Tier，根据 assess_lighting 返回的 gaps 驱动状态转换。
 * 所有状态转换由代码判定（不依赖 LLM）。
 *
 * Phase 流转:
 *   SETUP → TUNING(Tier1) → TUNING(Tier2) → POSTPROCESS_SETUP → TUNING(Tier3) → FINAL
 */
import type { AssessLightingResult } from "../tools/assess-lighting.ts";

// ── 类型 ──

export type Phase = "SETUP" | "TUNING" | "POSTPROCESS_SETUP" | "FINAL" | "DONE";

export interface PhaseState {
	phase: Phase;
	tier: number; // 1=CORE_LIGHTING, 2=ATMOSPHERE, 3=POSTPROCESS
	assessCount: number; // assess_lighting 调用次数
	checkCount: number; // check_dimension 调用次数
	lastGaps: Record<string, "minor" | "moderate" | "major">; // dimension → gap
	unchangedRounds: number; // 连续无变化的 assess_lighting 轮数
	artificialityDetected: boolean;
}

// ── 初始状态 ──

export function createInitialState(): PhaseState {
	return {
		phase: "SETUP",
		tier: 0,
		assessCount: 0,
		checkCount: 0,
		lastGaps: {},
		unchangedRounds: 0,
		artificialityDetected: false,
	};
}

// ── 状态转换 ──

function allTierDimsMinor(state: PhaseState, tier: number, gaps: AssessLightingResult["gaps"] | undefined): boolean {
	if (!gaps || !state.lastGaps || Object.keys(state.lastGaps).length === 0) return false;
	// 此 tier 的所有维度是否都是 minor
	return gaps.filter((g) => g.tier === tier).every((g) => g.gap === "minor");
}

/**
 * assess_lighting 返回后调用。
 * 根据当前 gaps 判断是否应该进入下一个 Phase/Tier。
 */
export function onAssessLighting(
	state: PhaseState,
	gaps: AssessLightingResult["gaps"] | undefined,
	artificiality: boolean,
): PhaseState {
	state.assessCount++;
	state.artificialityDetected = artificiality;

	if (!gaps) return state;

	// 检查是否有变化
	const newGaps: Record<string, "minor" | "moderate" | "major"> = {};
	for (const g of gaps) newGaps[g.dimension] = g.gap;

	const prev = state.lastGaps;
	const hasChanges = Object.keys(newGaps).some((k) => newGaps[k] !== prev[k]);
	state.unchangedRounds = hasChanges ? 0 : state.unchangedRounds + 1;
	state.lastGaps = newGaps;

	// Phase 转换逻辑
	switch (state.phase) {
		case "SETUP": {
			// 首次 assess_lighting → 进入 TUNING Tier1
			state.phase = "TUNING";
			state.tier = 1;
			break;
		}
		case "TUNING": {
			// 当前 Tier 全部 minor → 升级
			if (allTierDimsMinor(state, state.tier, gaps)) {
				if (state.tier === 1) {
					state.tier = 2;
				} else if (state.tier === 2) {
					state.phase = "POSTPROCESS_SETUP";
				} else if (state.tier === 3) {
					state.phase = "FINAL";
				}
			}
			break;
		}
		case "POSTPROCESS_SETUP": {
			// LLM 完成 PostProcess 初始化后，再次 assess_lighting → TUNING Tier3
			state.phase = "TUNING";
			state.tier = 3;
			break;
		}
		case "FINAL": {
			// 最终验证: 所有维度 minor → DONE
			if (gaps.every((g) => g.gap === "minor")) {
				state.phase = "DONE";
			}
			break;
		}
	}

	return state;
}

/**
 * check_dimension 调用后，增加计数。
 */
export function onCheckDimension(state: PhaseState): void {
	state.checkCount++;
}

// ── 硬上限检查 ──

export interface LimitCheck {
	/** 是否应该停止 */
	shouldStop: boolean;
	/** 停止原因 */
	reason?: string;
}

const MAX_ASSESS = 15;
const MAX_CHECKS = 20;
const MAX_UNCHANGED_ROUNDS = 3;

export function checkLimits(state: PhaseState): LimitCheck {
	if (state.assessCount >= MAX_ASSESS) {
		return { shouldStop: true, reason: `assess_lighting 调用次数已达上限 (${MAX_ASSESS})` };
	}
	if (state.checkCount >= MAX_CHECKS) {
		return { shouldStop: true, reason: `check_dimension 调用次数已达上限 (${MAX_CHECKS})` };
	}
	if (state.unchangedRounds >= MAX_UNCHANGED_ROUNDS) {
		return { shouldStop: true, reason: `连续 ${MAX_UNCHANGED_ROUNDS} 轮 gap 无变化，可能已达到物理极限` };
	}
	return { shouldStop: false };
}
