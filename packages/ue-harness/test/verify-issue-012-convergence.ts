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
	TIER_MAX_ROUNDS,
	PLATEAU_ROUNDS,
	OSCILLATION_REVERSALS,
} from "../src/workflow/phase-machine.ts";
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
	recordWrite(s, "DL", "temperature", 6500, 4300);
	recordWrite(s, "DL", "temperature", 4300, 5200);
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
	recordWrite(s3, "DL", "temperature", 6500, 4300); // idx0 (mark 之前)
	recordWrite(s3, "DL", "temperature", 4300, 5200); // idx1 (mark 之后)
	recordWrite(s3, "SL", "lightColor", { r: 1, g: 1, b: 1 }, { r: 1, g: 0.95, b: 0.85 }); // idx2
	s3.bestRound = { assessIndex: 1, closeEnoughCount: 1, needsAdjustmentCount: 0, overall: "", journalMark: 1 };
	const rb32 = computeRollbackWrites(s3);
	check("3.2 回滚 2 个 actor", rb32.length === 2);
	const dl32 = rb32.find((w) => w.refPath === "DL");
	check("3.2 DL.temperature 回到 4300 (mark 时刻值)", (dl32?.props.temperature as number) === 4300);
	const sl32 = rb32.find((w) => w.refPath === "SL");
	check("3.2 SL.lightColor 回到 from 值", ((sl32?.props.lightColor as { g: number }).g) === 1);

	// 3.3 mark=0, 只有一个"mark 之后才碰"的参数 → 回滚到 from (原始值 6500)
	s3 = createInitialState();
	recordWrite(s3, "DL", "temperature", 6500, 4300); // idx0 (mark=0 之后)
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
	for (const v of [4300, 5200, 4800, 5100, 4600]) recordWrite(s, "DL", "temperature", v - 1, v);
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
	recordWrite(s6, "DL", "temperature", 6500, 4300);
	recordWrite(s6, "DL", "temperature", 4300, 5200);
	recordWrite(s6, "DL", "temperature", 5200, 4800);
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round2
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round3
	s6 = onAssessLighting(s6, [needs("a", 1)], "x"); // round4 → plateau
	check("6.1 停滞触发 pendingRollback", Array.isArray(s6.pendingRollback) && (s6.pendingRollback?.length ?? 0) > 0);
	check("6.2 回滚内容 = 恢复最佳轮参数", (s6.pendingRollback?.[0]?.props.temperature as number) === 6500);
	check("6.3 已进入 tier2", s6.tier === 2);

	// ── Test 7: advanceTier 全路径 (正常收敛，覆盖 prePhase + FINAL) ──
	console.log("\n── Test 7: advanceTier 全路径 ──");
	let s7 = createInitialState();
	s7 = onAssessLighting(s7, [closed("a", 1)], "x"); // SETUP → TUNING tier1
	check("7.1 SETUP → TUNING tier1", s7.phase === "TUNING" && s7.tier === 1);
	s7 = onAssessLighting(s7, [closed("a", 1)], "x"); // tier1 全 close → tier2
	check("7.2 tier1 全 close → tier2", s7.tier === 2, `tier=${s7.tier}`);
	s7 = onAssessLighting(s7, [closed("a", 2)], "x"); // tier2 全 close → POSTPROCESS_SETUP (prePhase)
	check("7.3 tier2 全 close → POSTPROCESS_SETUP", s7.phase === "POSTPROCESS_SETUP", `phase=${s7.phase}`);
	s7 = onAssessLighting(s7, [closed("a", 3)], "x"); // POSTPROCESS_SETUP → TUNING tier3
	check("7.4 POSTPROCESS_SETUP → TUNING tier3", s7.phase === "TUNING" && s7.tier === 3, `phase=${s7.phase}, tier=${s7.tier}`);
	s7 = onAssessLighting(s7, [closed("a", 3)], "x"); // tier3 全 close → FINAL
	check("7.5 tier3 全 close → FINAL", s7.phase === "FINAL", `phase=${s7.phase}`);
	s7 = onAssessLighting(s7, [closed("a", 3)], "x"); // FINAL 全 close → DONE
	check("7.6 FINAL 全 close → DONE", s7.phase === "DONE", `phase=${s7.phase}`);

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
