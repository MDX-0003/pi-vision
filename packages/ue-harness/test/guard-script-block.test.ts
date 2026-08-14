/**
 * Issue 012 review (S1) — guard 拦截 execute_tool_script
 *
 * execute_tool_script 内嵌的工具调用对 guard 与 changeJournal 不可见
 * (脚本写的参数不进 journal → 回滚无法恢复; tier 门控失效)。
 * 调参任务的所有写必须走受控的 set_properties / set_actor_transform。
 *
 * 运行: node --import tsx test/guard-script-block.test.ts
 */

import { checkToolCall } from "../src/workflow/guard-rules.ts";
import { createInitialState, onAssessLighting } from "../src/workflow/phase-machine.ts";
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
const closed = (aspect: string, tier = 1): AnalysisEntry => ({ aspect, status: "close_enough", tier, suggestion: "" });

function main() {
	console.log("=".repeat(60));
	console.log("S1 — guard blocks execute_tool_script");
	console.log("=".repeat(60));

	// SETUP 阶段
	let s = createInitialState();
	const g1 = checkToolCall("toolset_registry.toolsets.core.programmatic.ProgrammaticToolset.execute_tool_script", { script: "..." }, s);
	check("1.1 SETUP 拦截", g1.block === true);
	check("1.2 原因明确", (g1.reason ?? "").includes("execute_tool_script"));

	// TUNING 阶段 (tier 1)
	s = onAssessLighting(s, [needs("a", 1)], "x");
	const g2 = checkToolCall("...ProgrammaticToolset.execute_tool_script", { script: "..." }, s);
	check("2.1 TUNING 拦截", g2.block === true);

	// 任何阶段都拦截 (FINAL 也算)
	const g3 = checkToolCall("...execute_tool_script", {}, { ...s, phase: "FINAL" } as never);
	check("3.1 FINAL 也拦截", g3.block === true);

	// 对照: 受控写工具在 TUNING 不因该规则被拦 (推进到 tier 2 后写 tier 2 的 intensity)
	s = onAssessLighting(s, [closed("a", 1)], "x"); // all closed → tier 2
	const g4 = checkToolCall("toolset_registry.toolsets.core.object.ObjectTools.set_properties", { instance: { refPath: "/a" }, values: "{\"intensity\": 1}" }, s);
	check("4.1 set_properties 不受本规则影响", g4.block === false);

	// 对照: get_execution_environment (只读) 不拦
	const g5 = checkToolCall("...ProgrammaticToolset.get_execution_environment", {}, s);
	check("5.1 get_execution_environment 不拦 (只读)", g5.block === false);

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ S1 guard 拦截全部通过");
	console.log("=".repeat(60));
}

main();
