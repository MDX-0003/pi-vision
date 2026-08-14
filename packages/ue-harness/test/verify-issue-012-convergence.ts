/**
 * Issue 012 Verification — Tier 停滞收敛与回滚
 *
 * 验证: changeJournal 记录 / computeRollbackWrites / detectStall /
 *       onAssessLighting 停滞强制推进 + 回滚。
 * 纯逻辑测试, 不依赖 Pi runtime 或 UE。
 *
 * 运行: npx tsx test/verify-issue-012-convergence.ts
 */

import {
	createInitialState,
	onAssessLighting,
	recordWrite,
	computeRollbackWrites,
	detectStall,
	detectRegression,
	TIER_MAX_ROUNDS,
	PLATEAU_ROUNDS,
	OSCILLATION_REVERSALS,
} from "../src/workflow/phase-machine.ts";
import type { QuantitativeSnapshot } from "../src/workflow/phase-machine.ts";
import type { AnalysisEntry } from "../src/tools/assess-lighting.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0,
	failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) {
		console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

const closed = (aspect: string, tier = 1): AnalysisEntry => ({ aspect, status: "close_enough", tier, suggestion: "" });
const needs = (aspect: string, tier = 1): AnalysisEntry => ({ aspect, status: "needs_adjustment", tier, suggestion: "" });

function main() {
	console.log("=".repeat(60));
	console.log("Issue 012 Verification — Tier 停滞收敛与回滚");
	console.log("=".repeat(60));

	// ── Test 1: 初始状态 ──
	console.log("\n── Test 1: 初始状态 ──");
	let s = createInitialState();
	check("1.1 changeJournal 初始为空", Array.isArray(s.changeJournal) && s.changeJournal.length === 0);
	check("1.2 pendingRollback 初始为 null", s.pendingRollback === null);
	check("1.3 roundsSinceImprovement 初始为 0", s.roundsSinceImprovement === 0);
	check("1.4 lastStall 初始为 null", s.lastStall === null);

	// ── Test 2: recordWrite ──
	console.log("\n── Test 2: recordWrite ──");
	s = createInitialState();
	recordWrite(s, "DL", "temperature", 6500, 4300, "properties");
	recordWrite(s, "DL", "temperature", 4300, 5200, "properties");
	check("2.1 追加 2 条记录", s.changeJournal.length === 2);
	check("2.2 from/to 正确", s.changeJournal[1].from === 4300 && s.changeJournal[1].to === 5200);

	// ── Test 3: computeRollbackWrites ──
	console.log("\n── Test 3: computeRollbackWrites ──");

	// 3.1 空日志
	let s3 = createInitialState();
	s3.bestRound = { assessIndex: 1, closeEnoughCount: 1, needsAdjustmentCount: 0, overall: "", journalMark: 0 };
	check("3.1 空日志 → 无回滚", computeRollbackWrites(s3).length === 0);

	// 3.2 mark=1, 之后温度多写一次 + 新参数
	s3 = createInitialState();
	recordWrite(s3, "DL", "temperature", 6500, 4300, "properties"); // idx0 (mark 之前)
	recordWrite(s3, "DL", "temperature", 4300, 5200, "properties"); // idx1 (mark 之后)
	recordWrite(s3, "SL", "lightColor", { r: 1, g: 1, b: 1 }, { r: 1, g: 0.95, b: 0.85 }, "properties"); // idx2
	s3.bestRound = { assessIndex: 1, closeEnoughCount: 1, needsAdjustmentCount: 0, overall: "", journalMark: 1 };
	const rb32 = computeRollbackWrites(s3);
	check("3.2 回滚 2 个 actor", rb32.length === 2);
	const dl32 = rb32.find((w) => w.refPath === "DL");
	check("3.2 DL.temperature 回到 4300 (mark 时刻值)", (dl32?.props.temperature as number) === 4300);
	const sl32 = rb32.find((w) => w.refPath === "SL");
	check("3.2 SL.lightColor 回到 from 值", ((sl32?.props.lightColor as { g: number }).g) === 1);

	// 3.3 mark=0, 只有一个"mark 之后才碰"的参数 → 回滚到 from (原始值 6500)
	s3 = createInitialState();
	recordWrite(s3, "DL", "temperature", 6500, 4300, "properties"); // idx0 (mark=0 之后)
	s3.bestRound = { assessIndex: 1, closeEnoughCount: 1, needsAdjustmentCount: 0, overall: "", journalMark: 0 };
	const rb33 = computeRollbackWrites(s3);
	check("3.3 单参数回滚到 from=6500", rb33.length === 1 && (rb33[0].props.temperature as number) === 6500);

	// ── Test 4: detectStall ──
	console.log("\n── Test 4: detectStall ──");

	// 4.1 round_cap
	s = createInitialState();
	s.phase = "TUNING";
	s.tier = 1;
	s.tierRoundCount = TIER_MAX_ROUNDS;
	const stallCap = detectStall(s);
	check("4.1 轮次上限 → round_cap", stallCap.stalled && stallCap.kind === "round_cap");

	// 4.2 plateau
	s = createInitialState();
	s.phase = "TUNING";
	s.tier = 1;
	s.tierRoundCount = 1;
	s.roundsSinceImprovement = PLATEAU_ROUNDS;
	const stallPlat = detectStall(s);
	check("4.2 平台 → plateau", stallPlat.stalled && stallPlat.kind === "plateau");

	// 4.3 oscillation: temperature 反复反转 ≥ 3 次
	s = createInitialState();
	s.phase = "TUNING";
	s.tier = 1;
	s.tierRoundCount = 1;
	// 4300 → 5200(↑) → 4800(↓,rev1) → 5100(↑,rev2) → 4600(↓,rev3)
	for (const v of [4300, 5200, 4800, 5100, 4600]) recordWrite(s, "DL", "temperature", v - 1, v, "properties");
	const stallOsc = detectStall(s);
	check(`4.3 震荡 → oscillation (反转 ${OSCILLATION_REVERSALS} 次)`, stallOsc.stalled && stallOsc.kind === "oscillation");

	// 4.4 未停滞
	s = createInitialState();
	s.phase = "TUNING";
	s.tier = 1;
	s.tierRoundCount = 1;
	s.roundsSinceImprovement = 0;
	const noStall = detectStall(s);
	check("4.4 正常 → 不停滞", !noStall.stalled);

	// ── Test 5: onAssessLighting 停滞强制推进 ──
	console.log("\n── Test 5: onAssessLighting 停滞强制推进 ──");

	let s5 = createInitialState();
	s5 = onAssessLighting(s5, [needs("a", 1)], "x"); // SETUP → TUNING tier1
	check("5.1 SETUP → TUNING tier1", s5.phase === "TUNING" && s5.tier === 1);

	// 连续 3 轮无改善 → 平台 → 强制进入 tier2
	s5 = onAssessLighting(s5, [needs("a", 1)], "x"); // TUNING round1: 建立 best
	s5 = onAssessLighting(s5, [needs("a", 1)], "x"); // round2: no improve
	s5 = onAssessLighting(s5, [needs("a", 1)], "x"); // round3: no improve
	s5 = onAssessLighting(s5, [needs("a", 1)], "x"); // round4: roundsSinceImprovement=3 → plateau
	check("5.2 平台停滞 → 自动进入 tier2", s5.tier === 2, `tier=${s5.tier}`);
	check("5.3 停滞记录 lastStall", s5.lastStall?.kind === "plateau", `kind=${s5.lastStall?.kind}`);
	check("5.4 推进后 changeJournal 清空", s5.changeJournal.length === 0);
	check("5.5 推进后 roundsSinceImprovement 归零", s5.roundsSinceImprovement === 0);

	// ── Test 6: 停滞回滚 (有写日志时) ──
	console.log("\n── Test 6: 停滞回滚 ──");
	let s6 = createInitialState();
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // → TUNING tier1
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round1: 建立 best (journalMark=0)
	// 记录几笔写 (模拟 LLM 震荡)
	recordWrite(s6, "DL", "temperature", 6500, 4300, "properties");
	recordWrite(s6, "DL", "temperature", 4300, 5200, "properties");
	recordWrite(s6, "DL", "temperature", 5200, 4800, "properties");
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round2
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round3
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round4 → plateau
	check("6.1 停滞触发 pendingRollback", Array.isArray(s6.pendingRollback) && (s6.pendingRollback?.length ?? 0) > 0);
	check("6.2 回滚内容 = 恢复最佳轮参数", (s6.pendingRollback?.[0]?.props.temperature as number) === 6500);
	check("6.3 已进入 tier2", s6.tier === 2);

	// ── Test 7: advanceTier 全路径 (正常收敛，覆盖 4-tier + prePhase + FINAL) ──
	console.log("\n── Test 7: advanceTier 全路径 ──");
	let s7 = createInitialState();
	s7 = onAssessLighting(s7, [closed("a", 1)], "x"); // SETUP → TUNING tier1 (方向)
	check("7.1 SETUP → TUNING tier1", s7.phase === "TUNING" && s7.tier === 1);
	s7 = onAssessLighting(s7, [closed("a", 1)], "x"); // tier1 全 close → tier2 (光源)
	check("7.2 tier1 全 close → tier2", s7.tier === 2, `tier=${s7.tier}`);
	s7 = onAssessLighting(s7, [closed("a", 2)], "x"); // tier2 全 close → tier3 (大气)
	check("7.3 tier2 全 close → tier3", s7.tier === 3, `tier=${s7.tier}`);
	s7 = onAssessLighting(s7, [closed("a", 3)], "x"); // tier3 全 close → POSTPROCESS_SETUP (prePhase on tier4)
	check("7.4 tier3 全 close → POSTPROCESS_SETUP", s7.phase === "POSTPROCESS_SETUP", `phase=${s7.phase}`);
	s7 = onAssessLighting(s7, [closed("a", 4)], "x"); // POSTPROCESS_SETUP → TUNING tier4 (后期)
	check("7.5 POSTPROCESS_SETUP → TUNING tier4", s7.phase === "TUNING" && s7.tier === 4, `phase=${s7.phase}, tier=${s7.tier}`);
	s7 = onAssessLighting(s7, [closed("a", 4)], "x"); // tier4 全 close → FINAL
	check("7.6 tier4 全 close → FINAL", s7.phase === "FINAL", `phase=${s7.phase}`);
	s7 = onAssessLighting(s7, [closed("a", 4)], "x"); // FINAL 全 close → DONE
	check("7.7 FINAL 全 close → DONE", s7.phase === "DONE", `phase=${s7.phase}`);

	// ── Test 8: 定量回归检测 (Issue 012) ──
	console.log("\n── Test 8: 定量回归检测 ──");

	const q = (lum: number, de: number): QuantitativeSnapshot => ({
		assessIndex: 0,
		luminanceDeltaPct: lum,
		deltaE_mean: de,
		deltaE_p90: de,
		chroma_diff: 0,
		skyLuminanceRatio: 0.3,
		groundLuminanceRatio: 0.6,
		histogramCorrelation: 0.9,
	});

	// 8.0 无 bestRound → 不触发
	check("8.0 无 bestRound 不触发", detectRegression(createInitialState()) === false);

	// 8.1-8.7 首次回归 → 回滚 + 留在本 tier
	let s8 = createInitialState();
	s8 = onAssessLighting(s8, [needs("a", 1)], "x", undefined, q(10, 16)); // SETUP→TUNING t1
	s8 = onAssessLighting(s8, [needs("a", 1)], "x", undefined, q(10, 16)); // TUNING round1: 建立 best.quant={10,16}
	check("8.1 建立 bestRound.quant", s8.bestRound?.quant?.luminanceDeltaPct === 10, `lum=${s8.bestRound?.quant?.luminanceDeltaPct}`);
	recordWrite(s8, "DL", "intensity", 10, 5, "properties");
	s8 = onAssessLighting(s8, [needs("a", 1)], "x", undefined, q(30, 22)); // lum +20>15, de +6>3 → 回归
	check("8.2 首次回归 → pendingRollback 非空", (s8.pendingRollback?.length ?? 0) > 0);
	check("8.3 首次回归 → tier 不变 (留在本 tier)", s8.tier === 1, `tier=${s8.tier}`);
	check("8.4 rollbackCount=1", s8.rollbackCount === 1);
	check("8.5 bestRound 基线前移 (journalMark=当前长度)", s8.bestRound?.journalMark === s8.changeJournal.length, `mark=${s8.bestRound?.journalMark}, len=${s8.changeJournal.length}`);
	check("8.6 lastStall.kind=regression", s8.lastStall?.kind === "regression");
	check("8.7 回滚内容 = 恢复最佳轮参数", (s8.pendingRollback?.[0]?.props.intensity as number) === 10);

	// 8.8 指标改善 → 不触发
	let s8b = createInitialState();
	s8b = onAssessLighting(s8b, [needs("a", 1)], "x", undefined, q(10, 16));
	s8b = onAssessLighting(s8b, [needs("a", 1)], "x", undefined, q(8, 14)); // 变好
	check("8.8 指标改善 → 不触发", s8b.pendingRollback === null && s8b.rollbackCount === 0);

	// 8.9 阈值内小波动 → 不触发
	let s8c = createInitialState();
	s8c = onAssessLighting(s8c, [needs("a", 1)], "x", undefined, q(10, 16));
	s8c = onAssessLighting(s8c, [needs("a", 1)], "x", undefined, q(14, 20)); // lum +4 < 15
	check("8.9 小波动 → 不触发", s8c.pendingRollback === null);

	// 8.10-8.11 二次回归 → 强制推进
	recordWrite(s8, "DL", "intensity", 5, 3, "properties");
	s8 = onAssessLighting(s8, [needs("a", 1)], "x", undefined, q(30, 22)); // 新基线后再次回归
	check("8.10 二次回归 → 强制推进 tier2", s8.tier === 2, `tier=${s8.tier}`);
	check("8.11 推进后 rollbackCount 清零", s8.rollbackCount === 0);

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ Issue 012 停滞收敛与回滚逻辑全部通过");
	console.log("=".repeat(60));
}

try {
	main();
} catch (err) {
	console.error("FATAL:", (err as Error).message);
	process.exit(1);
}
