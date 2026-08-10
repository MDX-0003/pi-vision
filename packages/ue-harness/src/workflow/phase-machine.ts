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

/** 单个维度的 gap 条目 (用于 buildGapSummary 输出明细表) */
export interface GapEntry {
	dimension: string;
	tier: number;
	gap: "minor" | "moderate" | "major";
	direction: string;
	ratingDiff: number;
	quantitative: {
		refValue: number;
		curValue: number;
		delta: string;
	} | null;
	qualitative: string | null;
}

export interface PhaseState {
	phase: Phase;
	tier: number; // 1=CORE_LIGHTING, 2=ATMOSPHERE, 3=POSTPROCESS
	assessCount: number; // assess_lighting 调用次数
	checkCount: number; // check_dimension 调用次数
	lastGapEntries: GapEntry[]; // 上一次 assess_lighting 的完整 gap 条目
	lastHistogramCorrelation: number; // 上一次的直方图相关性
	unchangedRounds: number; // 连续无变化的 assess_lighting 轮数
	artificialityDetected: boolean;
	blockingDimensions: string[]; // 阻塞维度列表
	lastCheckDimension: string | null; // 上一次 check_dimension 的维度
	consecutiveSameDimensionFurther: number; // 同一维度连续 further 次数
}

// ── 初始状态 ──

export function createInitialState(): PhaseState {
	return {
		phase: "SETUP",
		tier: 0,
		assessCount: 0,
		checkCount: 0,
		lastGapEntries: [],
		lastHistogramCorrelation: 1,
		unchangedRounds: 0,
		artificialityDetected: false,
		blockingDimensions: [],
		lastCheckDimension: null,
		consecutiveSameDimensionFurther: 0,
	};
}

// ── 状态转换 ──

function allTierDimsMinor(state: PhaseState, tier: number, gaps: AssessLightingResult["gaps"] | undefined): boolean {
	if (!gaps || state.lastGapEntries.length === 0) return false;
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
	blockingDimensions?: string[],
	histogramCorrelation?: number,
): PhaseState {
	state.assessCount++;
	state.artificialityDetected = artificiality;
	state.blockingDimensions = blockingDimensions ?? [];
	if (histogramCorrelation !== undefined) state.lastHistogramCorrelation = histogramCorrelation;

	if (!gaps) return state;

	// 检查是否有变化
	const newGaps: Record<string, "minor" | "moderate" | "major"> = {};
	for (const g of gaps) newGaps[g.dimension] = g.gap;

	// 存储完整 gap 条目
	state.lastGapEntries = gaps.map((g) => ({
		dimension: g.dimension,
		tier: g.tier,
		gap: g.gap,
		direction: g.direction,
		ratingDiff: g.rating_diff,
		quantitative: g.quantitative,
		qualitative: g.qualitative,
	}));

	const prev: Record<string, string> = {};
	for (const e of state.lastGapEntries) prev[e.dimension] = e.gap;
	const hasChanges = Object.keys(newGaps).some((k) => newGaps[k] !== prev[k]);
	state.unchangedRounds = hasChanges ? 0 : state.unchangedRounds + 1;

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
 * check_dimension 调用后，更新计数和 further 追踪。
 */
export function onCheckDimension(state: PhaseState, dimension: string, verdict: string): void {
	state.checkCount++;

	if (verdict === "further") {
		if (state.lastCheckDimension === dimension) {
			state.consecutiveSameDimensionFurther++;
		} else {
			state.consecutiveSameDimensionFurther = 1;
		}
	} else {
		state.consecutiveSameDimensionFurther = 0;
	}
	state.lastCheckDimension = dimension;
}

/**
 * 获取当前 further 阶段 (0=无 further, 1=第一次, 2=第二次, 3=第三次及以上)
 */
export function getFurtherStage(state: PhaseState): number {
	return state.consecutiveSameDimensionFurther;
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
const MAX_FURTHER_HARD_STOP = 3;

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
	if (state.consecutiveSameDimensionFurther >= MAX_FURTHER_HARD_STOP) {
		return {
			shouldStop: true,
			reason:
				`维度 "${state.lastCheckDimension}" 连续 ${MAX_FURTHER_HARD_STOP} 次 further。` +
				"已达到当前场景的物理极限或前置条件不满足。" +
				"请回退此维度的所有改动，调 assess_lighting 重新评估全局状态。" +
				"如果所有可调参数都已尝试，向用户报告最终状态和无法匹配的原因。",
		};
	}
	return { shouldStop: false };
}
