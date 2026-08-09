/**
 * Issue 005 Verification — Phase State Machine + Guard Rules
 *
 * Simulates the workflow state transitions and guard checks.
 * Does NOT require Pi runtime — pure logic test.
 *
 * 运行: npx tsx test/verify-issue-005.ts
 */

import { checkToolCall } from "../src/workflow/guard-rules.ts";
import { buildGapSummary, buildPhaseContext } from "../src/workflow/injections.ts";
import { checkLimits, createInitialState, onAssessLighting, onCheckDimension } from "../src/workflow/phase-machine.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0,
	failed = 0;
function check(n: string, ok: boolean, d = "") {
	if (ok) {
		console.log(`${PASS} ${n}${d ? ` — ${d}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${n}${d ? ` — ${d}` : ""}`);
		failed++;
	}
}

// Mock gaps: all major
const mockMajorGaps = [
	{
		dimension: "color_temperature",
		tier: 1,
		gap: "major" as const,
		direction: "too_cool",
		rating_diff: 3,
		quantitative: null,
		qualitative: "偏冷",
	},
	{
		dimension: "brightness",
		tier: 1,
		gap: "major" as const,
		direction: "too_bright",
		rating_diff: 3,
		quantitative: null,
		qualitative: "过亮",
	},
	{
		dimension: "atmosphere",
		tier: 2,
		gap: "major" as const,
		direction: "too_clear",
		rating_diff: 3,
		quantitative: null,
		qualitative: "太清晰",
	},
	{
		dimension: "contrast",
		tier: 3,
		gap: "major" as const,
		direction: "too_flat",
		rating_diff: 3,
		quantitative: null,
		qualitative: "对比不足",
	},
];

// Mock gaps: partially resolved (Tier1 minor, Tier2 moderate)
const mockPartialGaps = [
	{
		dimension: "color_temperature",
		tier: 1,
		gap: "minor" as const,
		direction: "close_enough",
		rating_diff: 0,
		quantitative: null,
		qualitative: null,
	},
	{
		dimension: "brightness",
		tier: 1,
		gap: "minor" as const,
		direction: "close_enough",
		rating_diff: 1,
		quantitative: null,
		qualitative: null,
	},
	{
		dimension: "atmosphere",
		tier: 2,
		gap: "moderate" as const,
		direction: "too_clear",
		rating_diff: 2,
		quantitative: null,
		qualitative: "还有差距",
	},
];

// All minor gaps
const mockAllMinorGaps = [
	{
		dimension: "color_temperature",
		tier: 1,
		gap: "minor" as const,
		direction: "close_enough",
		rating_diff: 0,
		quantitative: null,
		qualitative: null,
	},
	{
		dimension: "brightness",
		tier: 1,
		gap: "minor" as const,
		direction: "close_enough",
		rating_diff: 0,
		quantitative: null,
		qualitative: null,
	},
	{
		dimension: "atmosphere",
		tier: 2,
		gap: "minor" as const,
		direction: "close_enough",
		rating_diff: 0,
		quantitative: null,
		qualitative: null,
	},
	{
		dimension: "contrast",
		tier: 3,
		gap: "minor" as const,
		direction: "close_enough",
		rating_diff: 0,
		quantitative: null,
		qualitative: null,
	},
];

async function main() {
	console.log("=".repeat(60));
	console.log("Issue 005 Verification — Workflow State Machine");
	console.log("=".repeat(60));
	console.log("");

	// ════════════════════════════════════════════
	// Test 1: Phase transitions
	// ════════════════════════════════════════════
	console.log("── Test 1: Phase Transitions ──");

	let s = createInitialState();
	check("1.1 Initial state", s.phase === "SETUP" && s.tier === 0);

	// After first assess_lighting (major gaps)
	s = onAssessLighting(s, mockMajorGaps, false);
	check("1.2 SETUP → TUNING(Tier1)", s.phase === "TUNING" && s.tier === 1, `phase=${s.phase}, tier=${s.tier}`);
	check("1.3 assessCount incremented", s.assessCount === 1);

	// Tier1 still major → should NOT advance
	s = onAssessLighting(s, mockMajorGaps, false);
	check(
		"1.4 Tier1 not resolved → stay TUNING(Tier1)",
		s.phase === "TUNING" && s.tier === 1,
		`phase=${s.phase}, tier=${s.tier}`,
	);

	// Tier1 resolved → Tier 2
	s = onAssessLighting(s, mockPartialGaps, false);
	check(
		"1.5 Tier1 resolved → TUNING(Tier2)",
		s.phase === "TUNING" && s.tier === 2,
		`phase=${s.phase}, tier=${s.tier}`,
	);

	// Tier2 resolved → POSTPROCESS_SETUP
	const tier2ResolvedGaps = mockPartialGaps.map((g) => (g.tier === 2 ? { ...g, gap: "minor" as const } : g));
	s = onAssessLighting(s, tier2ResolvedGaps, false);
	check("1.6 Tier2 resolved → POSTPROCESS_SETUP", s.phase === "POSTPROCESS_SETUP", `phase=${s.phase}`);

	// POSTPROCESS_SETUP → assess_lighting → TUNING(Tier3)
	s = onAssessLighting(s, mockAllMinorGaps, false);
	check(
		"1.7 POSTPROCESS_SETUP → TUNING(Tier3)",
		s.phase === "TUNING" && s.tier === 3,
		`phase=${s.phase}, tier=${s.tier}`,
	);

	// Tier3 resolved → FINAL
	s = onAssessLighting(s, mockAllMinorGaps, false);
	check("1.8 Tier3 resolved → FINAL", s.phase === "FINAL", `phase=${s.phase}`);

	// FINAL all minor → DONE
	s = onAssessLighting(s, mockAllMinorGaps, false);
	check("1.9 FINAL all minor → DONE", s.phase === "DONE", `phase=${s.phase}`);
	console.log("");

	// ════════════════════════════════════════════
	// Test 2: Tier gating
	// ════════════════════════════════════════════
	console.log("── Test 2: Tier Gating ──");

	let s2 = createInitialState();
	s2 = onAssessLighting(
		s2,
		[
			{
				dimension: "color_temperature",
				tier: 1,
				gap: "major" as const,
				direction: "too_cool",
				rating_diff: 3,
				quantitative: null,
				qualitative: "偏冷",
			},
		],
		false,
	);

	// Try to set PostProcessVolume property while in Tier 1
	const blocked = checkToolCall(
		"toolset_registry.toolsets.core.object.ObjectTools.set_properties",
		{ instance: { refPath: "PostProcessVolume_0" }, values: '{"whiteTemp":6500}' },
		s2,
	);
	check("2.1 Block Tier3 write when Tier1 unresolved", blocked.block, blocked.reason?.substring(0, 80) || "");
	check("2.2 Reason mentions Tier", blocked.reason?.includes("Tier 1") || false);

	// Try to set DirectionalLight property while in Tier 1 → allowed
	const allowed = checkToolCall(
		"toolset_registry.toolsets.core.object.ObjectTools.set_properties",
		{ instance: { refPath: "DirectionalLight_0.LightComponent0" }, values: '{"intensity":5}' },
		s2,
	);
	check("2.3 Allow Tier1 write when in Tier1", !allowed.block);
	console.log("");

	// ════════════════════════════════════════════
	// Test 3: Phase constraints
	// ════════════════════════════════════════════
	console.log("── Test 3: Phase Constraints ──");

	const s3 = createInitialState(); // SETUP

	const setupBlocked = checkToolCall(
		"toolset_registry.toolsets.core.object.ObjectTools.set_properties",
		{ instance: { refPath: "x" }, values: "{}" },
		s3,
	);
	check("3.1 SETUP blocks writes", setupBlocked.block);
	check("3.2 SETUP reason mentions SETUP", setupBlocked.reason?.includes("SETUP") || false);

	// POSTPROCESS_SETUP blocks screenshots
	let s3b = createInitialState();
	s3b = onAssessLighting(s3b, mockAllMinorGaps, false); // → TUNING Tier1
	s3b = onAssessLighting(s3b, mockAllMinorGaps, false); // → TUNING Tier2
	s3b = onAssessLighting(s3b, mockAllMinorGaps, false); // → POSTPROCESS_SETUP

	const ppBlocked = checkToolCall("ViewportCaptureToolset.ViewportCaptureToolset.CaptureViewportImage", {}, s3b);
	check("3.3 POSTPROCESS_SETUP blocks screenshots", ppBlocked.block, ppBlocked.reason?.substring(0, 60) || "");
	console.log("");

	// ════════════════════════════════════════════
	// Test 4: Limit checks
	// ════════════════════════════════════════════
	console.log("── Test 4: Limits ──");

	let s4 = createInitialState();
	for (let i = 0; i < 16; i++) {
		s4 = onAssessLighting(s4, mockMajorGaps, false);
	}
	const limit = checkLimits(s4);
	check("4.1 15 assess → stop", limit.shouldStop);
	check("4.2 Stop reason mentions limit", limit.reason?.includes("15") || false);

	// check_dimension limit
	const s4b = createInitialState();
	for (let i = 0; i < 21; i++) onCheckDimension(s4b);
	const limit2 = checkLimits(s4b);
	check("4.3 20 checks → stop", limit2.shouldStop);
	console.log("");

	// ════════════════════════════════════════════
	// Test 5: unchanged rounds
	// ════════════════════════════════════════════
	console.log("── Test 5: Unchanged Rounds ──");

	let s5 = createInitialState();
	s5 = onAssessLighting(s5, mockMajorGaps, false);
	check("5.1 After first assess: unchangedRounds=0", s5.unchangedRounds === 0);

	s5 = onAssessLighting(s5, mockMajorGaps, false); // same gaps
	check("5.2 Same gaps: unchangedRounds=1", s5.unchangedRounds === 1);

	s5 = onAssessLighting(s5, mockMajorGaps, false); // same gaps again
	s5 = onAssessLighting(s5, mockMajorGaps, false); // same gaps again
	check("5.3 3 unchanged → limit triggers", s5.unchangedRounds >= 3, `${s5.unchangedRounds} rounds`);

	const limit3 = checkLimits(s5);
	check("5.4 3 unchanged → should stop", limit3.shouldStop);
	console.log("");

	// ════════════════════════════════════════════
	// Test 6: Injections
	// ════════════════════════════════════════════
	console.log("── Test 6: Injections ──");

	let s6 = createInitialState();
	const ctx = buildPhaseContext(s6);
	check("6.1 SETUP context mentions SETUP", ctx.includes("SETUP"));

	s6 = onAssessLighting(s6, mockMajorGaps, false);
	const ctx2 = buildPhaseContext(s6);
	check("6.2 TUNING context mentions Tier 1", ctx2.includes("Tier 1") && ctx2.includes("TUNING"));

	const gs = buildGapSummary(s6);
	check("6.3 Gap summary has major entries", gs.includes("major"));

	let sDone = createInitialState();
	for (let i = 0; i < 10; i++) sDone = onAssessLighting(sDone, mockAllMinorGaps, false);
	const ctxDone = buildPhaseContext(sDone);
	check("6.4 DONE context", ctxDone.includes("DONE"));

	console.log("");
	console.log("=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ 所有工作流状态转换和规则验证通过");
	console.log("=".repeat(60));
}

main().catch((err) => {
	console.error("FATAL:", err.message);
	process.exit(1);
});
