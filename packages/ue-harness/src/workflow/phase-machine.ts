/**
 * Issue 009c — Phase 状态机
 *
 * 重写: 基于 Vision analysis (而非 code-computed gap) 驱动状态转换。
 * 新增 tierRoundCount / bestRound / quantitativeSnapshots 追踪。
 * 移除 check_dimension 相关全部逻辑。
 *
 * Phase 流转:
 *   SETUP → TUNING(Tier1) → TUNING(Tier2) → POSTPROCESS_SETUP → TUNING(Tier3) → FINAL → DONE
 */

import type { AnalysisEntry } from "../tools/assess-lighting.ts";

// ── Types ──

export type Phase = "SETUP" | "TUNING" | "POSTPROCESS_SETUP" | "FINAL" | "DONE";

/** 跨轮定量快照 (用于趋势注入) */
export interface QuantitativeSnapshot {
	assessIndex: number;
	luminanceDeltaPct: number;
	deltaE_mean: number;
	deltaE_p90: number;
	chroma_diff: number;
	skyLuminanceRatio: number;
	groundLuminanceRatio: number;
	histogramCorrelation: number;
}

export interface PhaseState {
	phase: Phase;
	tier: number; // 1=CORE_LIGHTING, 2=ATMOSPHERE, 3=POSTPROCESS
	assessCount: number;

	/** 上一次 assess_lighting 的 Vision analysis */
	lastAnalysis: AnalysisEntry[];

	/** Vision 总体评价 (1-2 句) */
	lastOverall: string;

	/** 上一次直方图相关性 (用于定量趋势) */
	lastHistogramCorrelation: number;

	/** status=needs_adjustment 的 aspect 名列表 (取代旧的 blockingDimensions) */
	blockingAspects: string[];

	// ── Issue 009 新增: tier 轮数追踪 ──

	/** 当前 tier 内 assess_lighting 调用次数 (tier 升级时归零) */
	tierRoundCount: number;

	/** 本 tier 内 close_enough 数量最多的一轮 (用于收尾提示) */
	bestRound: {
		assessIndex: number;   // 全局 assessCount
		closeEnoughCount: number;
		needsAdjustmentCount: number;
		overall: string;
	} | null;

	/** 最近 3 轮定量快照 (newest last), 供跨轮趋势注入 */
	quantitativeSnapshots: QuantitativeSnapshot[];

	// ── Issue 008c 保留 ──
	lastTagResult?: import("../vision/analyzer.ts").TagResult;
}

// ── 常量 ──

/** 每个 tier 最多 10 轮调参。超过不强制推进，通过注入提示 LLM 自行选择 */
export const TIER_MAX_ROUNDS = 10;

/** 全局 assess_lighting 调用上限 (3 tiers × 10 rounds) */
const MAX_ASSESS = 30;

// ── 初始状态 ──

export function createInitialState(): PhaseState {
	return {
		phase: "SETUP",
		tier: 0,
		assessCount: 0,
		lastAnalysis: [],
		lastOverall: "",
		lastHistogramCorrelation: 1,
		blockingAspects: [],
		tierRoundCount: 0,
		bestRound: null,
		quantitativeSnapshots: [],
	};
}

// ── Tier 升级判定 ──

/** 当前 tier 所有 aspect 是否都已 close_enough */
export function allTierAspectsClosed(analysis: AnalysisEntry[], tier: number): boolean {
	const tierAspects = analysis.filter((a) => a.tier === tier);
	if (tierAspects.length === 0) return true;
	return tierAspects.every((a) => a.status === "close_enough");
}

// ── bestRound 追踪 ──

function trackBestRound(state: PhaseState, analysis: AnalysisEntry[], overall: string): void {
	const ce = analysis.filter((a) => a.status === "close_enough").length;
	const na = analysis.filter((a) => a.status === "needs_adjustment").length;

	if (
		!state.bestRound ||
		ce > state.bestRound.closeEnoughCount ||
		(ce === state.bestRound.closeEnoughCount && na < state.bestRound.needsAdjustmentCount)
	) {
		state.bestRound = {
			assessIndex: state.assessCount,
			closeEnoughCount: ce,
			needsAdjustmentCount: na,
			overall,
		};
	}
}

// ── Tier 推进 ──

function advanceTier(state: PhaseState): void {
	if (state.tier === 1) {
		state.tier = 2;
		state.tierRoundCount = 0;
		state.bestRound = null;
	} else if (state.tier === 2) {
		state.phase = "POSTPROCESS_SETUP";
		state.tierRoundCount = 0;
		state.bestRound = null;
	} else if (state.tier === 3) {
		state.phase = "FINAL";
		state.tierRoundCount = 0;
		state.bestRound = null;
	}
}

// ── 定量快照存储 ──

function pushQuantitativeSnapshot(
	state: PhaseState,
	snapshot: QuantitativeSnapshot,
): void {
	state.quantitativeSnapshots.push(snapshot);
	if (state.quantitativeSnapshots.length > 3) {
		state.quantitativeSnapshots.shift();
	}
}

// ── 主入口: assess_lighting 返回后调用 ──

export function onAssessLighting(
	state: PhaseState,
	analysis: AnalysisEntry[],
	overall: string,
	histogramCorrelation?: number,
	quantSnapshot?: QuantitativeSnapshot,
): PhaseState {
	state.assessCount++;
	state.tierRoundCount++;
	state.lastAnalysis = analysis;
	state.lastOverall = overall;
	if (histogramCorrelation !== undefined) state.lastHistogramCorrelation = histogramCorrelation;

	// 追踪本 tier 最佳轮
	trackBestRound(state, analysis, overall);

	// 存储定量快照
	if (quantSnapshot) {
		pushQuantitativeSnapshot(state, quantSnapshot);
	}

	// blocking aspects: status=needs_adjustment 的 aspect
	state.blockingAspects = analysis
		.filter((a) => a.status === "needs_adjustment")
		.map((a) => a.aspect);

	// Phase 转换逻辑
	switch (state.phase) {
		case "SETUP":
			state.phase = "TUNING";
			state.tier = 1;
			state.tierRoundCount = 0;
			state.bestRound = null;
			break;

		case "TUNING":
			// 正常路径: Vision 判定当前 tier 全部 close_enough → 自动升级
			if (allTierAspectsClosed(analysis, state.tier)) {
				advanceTier(state);
			}
			// tierRoundCount >= TIER_MAX_ROUNDS 不强制推进 — 由注入收尾提示处理
			break;

		case "POSTPROCESS_SETUP":
			state.phase = "TUNING";
			state.tier = 3;
			state.tierRoundCount = 0;
			state.bestRound = null;
			break;

		case "FINAL":
			if (analysis.every((a) => a.status === "close_enough")) {
				state.phase = "DONE";
			}
			break;
	}

	return state;
}

// ── 硬上限检查 ──

export interface LimitCheck {
	shouldStop: boolean;
	reason?: string;
}

export function checkLimits(state: PhaseState): LimitCheck {
	if (state.assessCount >= MAX_ASSESS) {
		return {
			shouldStop: true,
			reason: `assess_lighting 调用次数已达上限 (${MAX_ASSESS})`,
		};
	}
	return { shouldStop: false };
}
