/**
 * Issue 012 review — confirm_tier_done 工具测试
 *
 * 场景: 光照方向已达标时 LLM 无法表达"Tier 1 无需调整", 写更高 tier 被 guard 拦截。
 * confirm_tier_done 提供显式逃生口: 走 advanceTier 单入口推进。
 *
 * 运行: node --import tsx test/confirm-tier.test.ts
 */

import { createInitialState, onAssessLighting, confirmTierDone } from "../src/workflow/phase-machine.ts";
import { executeConfirmTierDone } from "../src/tools/confirm-tier.ts";
import { setPhaseState, getPhaseState } from "../src/state.ts";
import { checkToolCall } from "../src/workflow/guard-rules.ts";
import type { AnalysisEntry } from "../src/tools/assess-lighting.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) { console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`); passed++; }
	else { console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const needs = (aspect: string, tier = 1): AnalysisEntry => ({ aspect, status: "needs_adjustment", tier, suggestion: "" });

async function main() {
	console.log("=".repeat(60));
	console.log("confirm_tier_done — LLM 主动声明 Tier 完成");
	console.log("=".repeat(60));

	// ── Test 1: TUNING tier1 → 推进到 tier2, 清理跨 tier 状态 ──
	console.log("\n── Test 1: TUNING 推进 ──");
	let s = createInitialState();
	s = onAssessLighting(s, [needs("a", 1)], "x"); // SETUP → TUNING tier1
	recordWriteMock(s);
	check("1.1 初始 tier1", s.tier === 1);
	check("1.2 journal 有写记录", s.changeJournal.length === 1);
	confirmTierDone(s, "方向已匹配参考图, 无需调整");
	check("1.3 推进到 tier2", s.tier === 2, `tier=${s.tier}`);
	check("1.4 changeJournal 清空", s.changeJournal.length === 0);
	check("1.5 bestRound 重置", s.bestRound === null);
	check("1.6 rollbackCount 归零", s.rollbackCount === 0);

	// ── Test 2: 最后一个 tier (4) 确认 → FINAL ──
	console.log("\n── Test 2: 最后 tier → FINAL ──");
	let s2 = createInitialState();
	s2 = onAssessLighting(s2, [needs("a", 1)], "x");
	s2 = onAssessLighting(s2, [closed("a", 1)], "x"); // → tier2
	s2 = onAssessLighting(s2, [closed("a", 2)], "x"); // → tier3
	s2 = onAssessLighting(s2, [closed("a", 3)], "x"); // → POSTPROCESS_SETUP (tier4 prePhase)
	s2 = onAssessLighting(s2, [closed("a", 4)], "x"); // → TUNING tier4
	check("2.1 到达 tier4", s2.tier === 4);
	confirmTierDone(s2, "后期已达标");
	check("2.2 确认 tier4 → FINAL", s2.phase === "FINAL", `phase=${s2.phase}`);

	// ── Test 3: 非 TUNING 拒绝 ──
	console.log("\n── Test 3: 非 TUNING 拒绝 ──");
	let s3 = createInitialState(); // SETUP
	const tierBefore = s3.tier;
	confirmTierDone(s3, "不应生效");
	check("3.1 SETUP 下 no-op (tier 不变)", s3.tier === tierBefore);

	setPhaseState(s3);
	const res3 = await executeConfirmTierDone({ reason: "不应生效" });
	const out3 = JSON.parse((res3.content?.[0] as { text: string })?.text ?? "{}") as { success?: boolean; error?: string };
	check("3.2 工具层返回 success=false", out3.success === false);
	check("3.3 错误说明仅 TUNING 可用", (out3.error ?? "").includes("TUNING"));
	setPhaseState(null);

	// ── Test 4: 工具层正常路径 ──
	console.log("\n── Test 4: 工具正常路径 ──");
	let s4 = createInitialState();
	s4 = onAssessLighting(s4, [needs("a", 1)], "x");
	setPhaseState(s4);
	const res4 = await executeConfirmTierDone({ reason: "pitch -16 已匹配黄昏参考图" });
	const out4 = JSON.parse((res4.content?.[0] as { text: string })?.text ?? "{}") as {
		success?: boolean;
		confirmedTier?: number;
		nextTier?: number;
	};
	check("4.1 success=true", out4.success === true);
	check("4.2 confirmedTier=1", out4.confirmedTier === 1);
	check("4.3 nextTier=2", out4.nextTier === 2, `next=${out4.nextTier}`);
	check("4.4 全局 state 已推进到 tier2", getPhaseState()?.tier === 2);
	setPhaseState(null);

	// ── Test 5: guard 向前跳拦截文案含 confirm_tier_done 提示 ──
	console.log("\n── Test 5: guard 提示 ──");
	let s5 = createInitialState();
	s5 = onAssessLighting(s5, [needs("direction", 1)], "x"); // tier1 有 needs_adjustment
	const g5 = checkToolCall("toolset_registry.toolsets.core.object.ObjectTools.set_properties", { instance: { refPath: "/a" }, values: "{\"intensity\": 1}" }, s5);
	check("5.1 向前跳被拦", g5.block === true);
	check("5.2 文案含 confirm_tier_done 提示", (g5.reason ?? "").includes("confirm_tier_done"), g5.reason?.slice(0, 80));

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ confirm_tier_done 全部通过");
	console.log("=".repeat(60));
}

function recordWriteMock(state: { changeJournal: unknown[] }): void {
	state.changeJournal.push({ refPath: "/a", prop: "intensity", from: 10, to: 5, channel: "properties" });
}

const closed = (aspect: string, tier = 1): AnalysisEntry => ({ aspect, status: "close_enough", tier, suggestion: "" });

main().catch((err) => { console.error("FATAL:", (err as Error).message); process.exit(1); });
