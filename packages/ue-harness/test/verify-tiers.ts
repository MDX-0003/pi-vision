/**
 * Issue 012 Verification — Tier 注册表（tiers.ts）
 *
 * 验证: TIER_ORDER 数据 / resolveTier 归类 / nextTier 顺序 + prePhase /
 *       extractRefPath (instance/actor) / 渲染函数。
 * 纯逻辑测试, 不依赖 Pi runtime 或 UE。
 *
 * 运行: node --import tsx test/verify-tiers.ts
 */

import {
	TIER_ORDER,
	resolveTier,
	nextTier,
	tierCount,
	getTierDef,
	buildTunableLine,
	buildTierListDescription,
	extractRefPath,
	extractWriteTarget,
} from "../src/workflow/tiers.ts";

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

const SET_PROPS = "toolset_registry_toolsets_core_object_ObjectTools_set_properties";

function main() {
	console.log("=".repeat(60));
	console.log("Issue 012 Verification — Tier 注册表 (4-tier)");
	console.log("=".repeat(60));

	// ── Test 1: TIER_ORDER 数据 ──
	console.log("\n── Test 1: TIER_ORDER 数据 ──");
	check("1.1 4 个 tier", tierCount() === 4);
	check("1.2 id 为 1/2/3/4", TIER_ORDER.map((t) => t.id).join(",") === "1,2,3,4");
	check("1.3 Tier 1 是方向 (transformBased)", TIER_ORDER[0].label === "方向" && TIER_ORDER[0].transformBased === true);
	check("1.4 Tier 4 有 prePhase=POSTPROCESS_SETUP", TIER_ORDER[3].prePhase === "POSTPROCESS_SETUP");

	// ── Test 2: resolveTier 归类 ──
	console.log("\n── Test 2: resolveTier 归类 ──");

	check("2.1 set_actor_transform → 1", resolveTier("ActorTools_set_actor_transform", { actor: { refPath: "/DirectionalLight_0" } }) === 1);
	check("2.2 get_actor_transform → 1", resolveTier("ActorTools_get_actor_transform", {}) === 1);
	check(
		"2.3 DirectionalLight refPath → 2",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.DirectionalLight_0.LightComponent0" } }) === 2,
	);
	check(
		"2.4 SkyAtmosphere refPath → 3",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.SkyAtmosphere_0.SkyAtmosphereComponent" } }) === 3,
	);
	check(
		"2.5 PostProcessVolume refPath → 4",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.PostProcessVolume_0" } }) === 4,
	);
	check(
		"2.6 values 'temperature' → 2",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, values: '{"temperature": 4300}' }) === 2,
	);
	check(
		"2.7 values 'whiteTemp' → 4",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, values: '{"whiteTemp": 6500}' }) === 4,
	);
	check(
		"2.8 properties 'fogDensity' → 3",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, properties: { fogDensity: 0.02 } }) === 3,
	);
	check(
		"2.9 无匹配 → null",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, values: '{"unknownProp": 1}' }) === null,
	);

	// ── Test 3: nextTier 顺序 ──
	console.log("\n── Test 3: nextTier 顺序 ──");
	check("3.1 nextTier(1) → id 2", nextTier(1)?.id === 2);
	check("3.2 nextTier(2) → id 3", nextTier(2)?.id === 3);
	check("3.3 nextTier(3) → prePhase=POSTPROCESS_SETUP", nextTier(3)?.prePhase === "POSTPROCESS_SETUP");
	check("3.4 nextTier(4) → null", nextTier(4) === null);

	// ── Test 4: extractRefPath / extractWriteTarget ──
	console.log("\n── Test 4: extractRefPath / extractWriteTarget ──");
	check("4.1 instance.refPath", extractRefPath({ instance: { refPath: "/x" } }) === "/x");
	check("4.2 actor.refPath", extractRefPath({ actor: { refPath: "/y" } }) === "/y");
	check("4.3 instance 优先于 actor", extractRefPath({ instance: { refPath: "/x" }, actor: { refPath: "/y" } }) === "/x");
	check("4.4 无 refPath → undefined", extractRefPath({}) === undefined);
	check(
		"4.5 extractWriteTarget properties",
		(extractWriteTarget({ instance: { refPath: "/x" }, properties: { a: 1 } })?.props as Record<string, number>).a === 1,
	);

	// ── Test 5: 渲染 ──
	console.log("\n── Test 5: 渲染 ──");
	check("5.1 getTierDef(1).label = 方向", getTierDef(1)?.label === "方向");
	check("5.2 buildTunableLine(1) 含 transform", buildTunableLine(1).includes("transform"));
	check("5.3 buildTunableLine(2) 含 DirectionalLight", buildTunableLine(2).includes("DirectionalLight"));
	check(
		"5.4 buildTierListDescription 4 行",
		(buildTierListDescription().match(/- Tier \d:/g) || []).length === 4,
	);

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ Tier 注册表全部通过");
	console.log("=".repeat(60));
}

try {
	main();
} catch (err) {
	console.error("FATAL:", (err as Error).message);
	process.exit(1);
}
