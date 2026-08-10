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
	unchangedRounds: number; // 连续无改善的 assess_lighting 轮数
	artificialityDetected: boolean;
	blockingDimensions: string[]; // 阻塞维度列表
	lastCheckDimension: string | null; // 上一次 check_dimension 的维度
	consecutiveSameDimensionFurther: number; // 同一维度连续 further 次数
	/** 上一轮各维度的量化数值 (ref/cur)，用于数值级 delta 收敛判定 */
	lastQuantitative: Record<string, { refValue: number; curValue: number }>;
	/** 最近 3 轮各维度的 delta 绝对值历史 (dimension → deltas, newest last) */
	quantitativeHistory: Record<string, number[]>;
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
		lastQuantitative: {},
		quantitativeHistory: {},
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

	// unchangedRounds: 数值级 delta 收敛判定
	// 排除 overall_composition (结构性差异，无法通过调参解决)
	state.unchangedRounds = computeUnchangedRounds(state, gaps);
	storeQuantitative(state, gaps);

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

// ── unchangedRounds: 数值级 delta 收敛判定 ──

/** 有量化数据的维度名列表 */
const QUANTITATIVE_DIMS = ["brightness", "color_temperature", "saturation"];

/**
 * 基于量化 delta 数值判变。
 * 仅对有量化数据的维度 (brightness/color_temperature/saturation) 做比较。
 * overall_composition 被排除——它是结构性差异，无法通过调参解决。
 *
 * 规则:
 *  - 任何维度的 delta 绝对值缩小 10% 以上 → "改善"
 *  - 任何维度的 delta 绝对值扩大 10% 以上 → "恶化"
 *  - 恶化维度数 > 改善维度数 → unchangedRounds + 1
 *  - 改善维度数 == 0 且 恶化维度数 == 0 → unchangedRounds + 1 (完全停滞)
 *  - 否则 → unchangedRounds = 0 (有改善)
 */
function computeUnchangedRounds(state: PhaseState, gaps: AssessLightingResult["gaps"] | undefined): number {
	if (!gaps || state.assessCount <= 1) return 0;

	const prev = state.lastQuantitative;
	if (Object.keys(prev).length === 0) return 0;

	let improving = 0;
	let worsening = 0;

	for (const dim of QUANTITATIVE_DIMS) {
		// 排除 overall_composition
		if (dim === "overall_composition") continue;

		const gapEntry = gaps.find((g) => g.dimension === dim);
		const currQ = gapEntry?.quantitative;
		const prevQ = prev[dim];

		if (!currQ || !prevQ) continue;

		const prevDelta = Math.abs(prevQ.refValue - prevQ.curValue);
		const currDelta = Math.abs(currQ.refValue - currQ.curValue);

		if (prevDelta === 0) continue; // 前一轮数值异常，跳过

		const ratio = currDelta / prevDelta;

		if (ratio < 0.9) improving++;
		else if (ratio > 1.1) worsening++;
	}

	if (worsening > improving) return state.unchangedRounds + 1;
	if (improving === 0) return state.unchangedRounds + 1;
	return 0; // 有改善 → 重置
}

/** 从 gaps 中提取量化数值，存储到 state 供下一轮比较 + 维护 delta 历史 */
function storeQuantitative(state: PhaseState, gaps: AssessLightingResult["gaps"] | undefined): void {
	if (!gaps) return;
	const quantitative: Record<string, { refValue: number; curValue: number }> = {};
	for (const dim of QUANTITATIVE_DIMS) {
		const gapEntry = gaps.find((g) => g.dimension === dim);
		if (gapEntry?.quantitative) {
			quantitative[dim] = {
				refValue: gapEntry.quantitative.refValue,
				curValue: gapEntry.quantitative.curValue,
			};
			const delta = Math.abs(gapEntry.quantitative.refValue - gapEntry.quantitative.curValue);
			if (!state.quantitativeHistory[dim]) state.quantitativeHistory[dim] = [];
			state.quantitativeHistory[dim].push(delta);
			// 保留最近 3 轮
			if (state.quantitativeHistory[dim].length > 3) {
				state.quantitativeHistory[dim].shift();
			}
		}
	}
	state.lastQuantitative = quantitative;
}

/** 单维度趋势信息 */
export interface DimensionTrendInfo {
	history: string; // 趋势摘要文本，如 "+56.6% -> +27.7% -> +21.9% [+]"
	status: "converging" | "oscillating" | "worsening" | "stable";
}

/** 获取所有维度的趋势信息，供 buildGapSummary 使用 */
export function getDimensionTrends(state: PhaseState): Record<string, DimensionTrendInfo> {
	const result: Record<string, DimensionTrendInfo> = {};
	for (const dim of QUANTITATIVE_DIMS) {
		const history = state.quantitativeHistory[dim];
		if (!history || history.length < 2) continue;

		const entries = history.map((d) => `${d.toFixed(1)}`);
		// 判定趋势
		let improving = false;
		let worsening = false;
		for (let i = 1; i < history.length; i++) {
			const ratio = history[i] / history[i - 1];
			if (ratio < 0.9) improving = true;
			else if (ratio > 1.1) worsening = true;
		}

		let status: DimensionTrendInfo["status"];
		let marker: string;
		if (improving && !worsening) {
			status = "converging";
			marker = "[+]";
		} else if (worsening && !improving) {
			status = "worsening";
			marker = "[-]";
		} else if (improving && worsening) {
			status = "oscillating";
			marker = "[~]";
		} else {
			status = "stable";
			marker = "[=]";
		}

		const historyText = `${entries.join(" -> ")} ${marker}`;

		result[dim] = { history: historyText, status };
	}
	return result;
}

/** 检查是否所有有量化数据的 Tier 1 维度都已收敛或波动 */
export function isTierOneSettled(state: PhaseState): boolean {
	const trends = getDimensionTrends(state);
	const tier1Dims = QUANTITATIVE_DIMS.filter((d) => {
		const gap = state.lastGapEntries.find((g) => g.dimension === d);
		return gap?.tier === 1;
	});

	if (tier1Dims.length === 0) return false;

	return tier1Dims.every((d) => {
		const t = trends[d];
		return t && (t.status === "converging" || t.status === "oscillating" || t.status === "stable");
	});
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
