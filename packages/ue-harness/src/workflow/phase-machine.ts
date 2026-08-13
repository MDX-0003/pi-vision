/**
 * Issue 009c — Phase 状态机
 *
 * 重写: 基于 Vision analysis (而非 code-computed gap) 驱动状态转换。
 * 新增 tierRoundCount / bestRound / quantitativeSnapshots 追踪。
 * 移除 check_dimension 相关全部逻辑。
 *
 * Phase 流转:
 *   SETUP → TUNING(Tier1) → TUNING(Tier2) → POSTPROCESS_SETUP → TUNING(Tier3) → FINAL → DONE
 *
 * Issue 012 — 停滞收敛与回滚
 *   新增 changeJournal (from/to 变迁日志) + bestRound.journalMark +
 *   detectStall (round_cap/plateau/oscillation) + computeRollbackWrites。
 *   目标: 让"该进下一阶段了"成为机器判定的确定性事实，而非依赖 LLM/Vision 主观判断。
 *   TIER_MAX_ROUNDS 由"建议"改为"强制推进"。
 */

import type { AnalysisEntry } from "../tools/assess-lighting.ts";
import { nextTier, tierCount } from "./tiers.ts";

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

/** Issue 012: 单笔写操作的 from/to 变迁 (from=写前读到的旧值, to=写后新值) */
export interface JournalEntry {
	refPath: string;
	prop: string;
	from: unknown;
	to: unknown;
}

/** Issue 012: 回滚写 (按 refPath 合并, props = 要恢复的值) */
export interface RollbackWrite {
	refPath: string;
	props: Record<string, unknown>;
}

export type StallKind = "round_cap" | "plateau" | "oscillation";

/** Issue 012: 停滞检测结果 */
export interface StallDetection {
	stalled: boolean;
	kind: StallKind | null;
	reason: string;
}

export interface PhaseState {
	phase: Phase;
	tier: number; // 当前调参 tier（见 tiers.ts 的 TIER_ORDER）
	assessCount: number;

	/** 上一次 assess_lighting 的 Vision analysis */
	lastAnalysis: AnalysisEntry[];

	/** Vision 总体评价 (1-2 句) */
	lastOverall: string;

	/** 上一次直方图相关性 (用于定量趋势) */
	lastHistogramCorrelation: number;

	// ── Issue 009 新增: tier 轮数追踪 ──

	/** 当前 tier 内 assess_lighting 调用次数 (tier 升级时归零) */
	tierRoundCount: number;

	/** 本 tier 内 close_enough 数量最多的一轮 (用于收尾提示) */
	bestRound: {
		assessIndex: number;   // 全局 assessCount
		closeEnoughCount: number;
		needsAdjustmentCount: number;
		overall: string;
		/** Issue 012: 该最佳轮时 changeJournal 的长度 (回滚分界点) */
		journalMark: number;
	} | null;

	/** 最近 3 轮定量快照 (newest last), 供跨轮趋势注入 */
	quantitativeSnapshots: QuantitativeSnapshot[];

	// ── Issue 008c 保留 ──
	lastTagResult?: import("../vision/analyzer.ts").TagResult;

	// ── Issue 012 新增: 停滞收敛与回滚 ──

	/** 当前 tier 的写操作变迁日志 (append-only, tier 升级清空) */
	changeJournal: JournalEntry[];

	/** 停滞强制推进时待执行的回滚写 (由 index.ts 应用到 UE 后清空) */
	pendingRollback: RollbackWrite[] | null;

	/** 自上次 close_enough 改善以来的连续轮数 (平台检测) */
	roundsSinceImprovement: number;

	/** 最近一次停滞检测结果 (供注入提示, 下次 assess 时清零) */
	lastStall: StallDetection | null;
}

// ── 常量 ──

/** 每个 tier 最多 10 轮调参。Issue 012: 达到即强制推进 (不再是建议)。 */
export const TIER_MAX_ROUNDS = 10;

/** Issue 012: close_enough 连续 N 轮无改善 → 判定平台停滞 */
export const PLATEAU_ROUNDS = 3;

/** Issue 012: 同一参数方向反转 ≥ N 次 → 判定震荡 */
export const OSCILLATION_REVERSALS = 3;

/** 全局 assess_lighting 调用上限 (tier 数 × 每 tier 轮数) */
const MAX_ASSESS = tierCount() * TIER_MAX_ROUNDS;

// ── 初始状态 ──

export function createInitialState(): PhaseState {
	return {
		phase: "SETUP",
		tier: 0,
		assessCount: 0,
		lastAnalysis: [],
		lastOverall: "",
		lastHistogramCorrelation: 1,
		tierRoundCount: 0,
		bestRound: null,
		quantitativeSnapshots: [],
		changeJournal: [],
		pendingRollback: null,
		roundsSinceImprovement: 0,
		lastStall: null,
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

/** 返回 true 表示本轮刷新了最佳 (close_enough 改善) */
function trackBestRound(state: PhaseState, analysis: AnalysisEntry[], overall: string): boolean {
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
			journalMark: state.changeJournal.length,
		};
		return true;
	}
	return false;
}

// ── 写操作记录 (Issue 012) ──

/** index.ts 在每次 set_properties 前读旧值、写后调用本函数记录变迁 */
export function recordWrite(
	state: PhaseState,
	refPath: string,
	prop: string,
	from: unknown,
	to: unknown,
): void {
	state.changeJournal.push({ refPath, prop, from, to });
}

// ── 回滚计算 (Issue 012) ──

/**
 * 计算"回滚到最佳轮"所需的写操作列表 (纯函数, 不执行 UE 写)。
 *
 * 语义: 最佳轮状态 = base + changeJournal[0..journalMark)。要恢复它，
 * 需撤销 changeJournal[journalMark..] 的所有写。对每个 (refPath, prop)，
 * 取"mark 之后第一次写该 prop 的 from 值" (= 该 prop 在 mark 时刻的值)。
 */
export function computeRollbackWrites(state: PhaseState): RollbackWrite[] {
	const mark = state.bestRound?.journalMark ?? 0;
	if (state.changeJournal.length <= mark) return [];

	const undo = new Map<string, Record<string, unknown>>();
	for (let i = mark; i < state.changeJournal.length; i++) {
		const e = state.changeJournal[i];
		const props = undo.get(e.refPath) ?? {};
		if (!(e.prop in props)) {
			props[e.prop] = e.from;
		}
		undo.set(e.refPath, props);
	}

	return [...undo.entries()].map(([refPath, props]) => ({ refPath, props }));
}

// ── 停滞检测 (Issue 012) ──

/** 检测当前 tier 是否已停滞 (应停止调参、进入下一阶段) */
export function detectStall(state: PhaseState): StallDetection {
	// 1. 轮次上限
	if (state.tierRoundCount >= TIER_MAX_ROUNDS) {
		return {
			stalled: true,
			kind: "round_cap",
			reason: `Tier ${state.tier} 已进行 ${state.tierRoundCount} 轮 (上限 ${TIER_MAX_ROUNDS})，强制结束本阶段。`,
		};
	}

	// 2. 平台: close_enough 连续 PLATEAU_ROUNDS 轮无改善
	if (state.roundsSinceImprovement >= PLATEAU_ROUNDS) {
		return {
			stalled: true,
			kind: "plateau",
			reason: `连续 ${state.roundsSinceImprovement} 轮 close_enough 数量无改善，继续调参边际收益递减。`,
		};
	}

	// 3. 震荡: 同一参数方向反转 ≥ OSCILLATION_REVERSALS 次
	if (detectOscillation(state)) {
		return {
			stalled: true,
			kind: "oscillation",
			reason: `检测到参数震荡 (同一参数反复反转)，已到局部最优，继续调参只会来回摇摆。`,
		};
	}

	return { stalled: false, kind: null, reason: "" };
}

/** 对数值型参数统计方向反转次数 (仅比较 typeof to === "number" 的写) */
function detectOscillation(state: PhaseState): boolean {
	const seq = new Map<string, number[]>();
	for (const e of state.changeJournal) {
		if (typeof e.to !== "number") continue;
		const key = `${e.refPath}::${e.prop}`;
		const arr = seq.get(key) ?? [];
		arr.push(e.to);
		seq.set(key, arr);
	}

	for (const vals of seq.values()) {
		let reversals = 0;
		for (let i = 2; i < vals.length; i++) {
			const d1 = vals[i - 1] - vals[i - 2];
			const d2 = vals[i] - vals[i - 1];
			if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) reversals++;
		}
		if (reversals >= OSCILLATION_REVERSALS) return true;
	}
	return false;
}

// ── Tier 推进 ──

/** 清空跨-tier 追踪状态 (唯一清空点, 两条触发路径都走这里) */
function resetTierProgress(state: PhaseState): void {
	state.tierRoundCount = 0;
	state.bestRound = null;
	state.changeJournal = [];
	state.roundsSinceImprovement = 0;
}

function advanceTier(state: PhaseState): void {
	const next = nextTier(state.tier);
	if (next?.prePhase) {
		state.phase = next.prePhase;
		state.tier = next.id; // 记住 prePhase 对应的 tier，供 POSTPROCESS_SETUP 过渡用
	} else if (next) {
		state.tier = next.id;
	} else {
		state.phase = "FINAL";
	}
	resetTierProgress(state);
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

	// Issue 012: 上一轮的停滞提示已由注入消费, 本轮清零
	state.lastStall = null;

	// 追踪本 tier 最佳轮
	const improved = trackBestRound(state, analysis, overall);

	// 存储定量快照
	if (quantSnapshot) {
		pushQuantitativeSnapshot(state, quantSnapshot);
	}

	// Phase 转换逻辑
	switch (state.phase) {
		case "SETUP":
			state.phase = "TUNING";
			state.tier = 1;
			resetTierProgress(state);
			state.pendingRollback = null;
			break;

		case "TUNING": {
			// Issue 012: 平台追踪 (本轮是否改善了最佳 close_enough)
			state.roundsSinceImprovement = improved ? 0 : state.roundsSinceImprovement + 1;

			const allClosed = allTierAspectsClosed(analysis, state.tier);
			if (allClosed) {
				// 正常路径: Vision 判定当前 tier 全部 close_enough → 升级
				advanceTier(state);
			} else {
				// Issue 012: 停滞 → 回滚到最佳 + 强制推进
				const stall = detectStall(state);
				if (stall.stalled) {
					const rb = computeRollbackWrites(state);
					state.pendingRollback = rb;
					state.lastStall = {
						stalled: true,
						kind: stall.kind,
						reason:
							stall.reason +
							(rb.length > 0
								? ` 已回滚 ${rb.length} 个 actor 到历史最佳参数，进入下一阶段。`
								: " 进入下一阶段。"),
					};
					advanceTier(state);
				}
			}
			break;
		}

		case "POSTPROCESS_SETUP":
			state.phase = "TUNING"; // tier 已由 advanceTier 设为 prePhase 对应 tier
			resetTierProgress(state);
			state.pendingRollback = null;
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
