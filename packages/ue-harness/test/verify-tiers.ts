/**
 * Issue 012 Verification — Tier 注册表（tiers.ts）
 *
 * 验证: TIER_ORDER 数据 / resolveTier 归类 / nextTier 顺序 + prePhase / 渲染函数。
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
	console.log("Issue 012 Verification — Tier 注册表");
	console.log("=".repeat(60));

	// ── Test 1: TIER_ORDER 数据 ──
	console.log("\n── Test 1: TIER_ORDER 数据 ──");
	check("1.1 3 个 tier", tierCount() === 3);
	check("1.2 id 为 1/2/3", TIER_ORDER.map((t) => t.id).join(",") === "1,2,3");
	check("1.3 Tier 3 有 prePhase=POSTPROCESS_SETUP", TIER_ORDER[2].prePhase === "POSTPROCESS_SETUP");
	check("1.4 Tier 1/2 无 prePhase", TIER_ORDER[0].prePhase === undefined && TIER_ORDER[1].prePhase === undefined);

	// ── Test 2: resolveTier 归类 ──
	console.log("\n── Test 2: resolveTier 归类 ──");

	// refPath → tier
	check(
		"2.1 DirectionalLight refPath → 1",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.DirectionalLight_0.LightComponent0" } }) === 1,
	);
	check(
		"2.2 SkyLight refPath → 1",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.SkyLight_0.SkyLightComponent0" } }) === 1,
	);
	check(
		"2.3 SkyAtmosphere refPath → 2",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.SkyAtmosphere_0.SkyAtmosphereComponent" } }) === 2,
	);
	check(
		"2.4 VolumetricCloud refPath → 2",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.VolumetricCloud_0.VolumetricCloudComponent" } }) === 2,
	);
	check(
		"2.5 PostProcessVolume refPath → 3",
		resolveTier(SET_PROPS, { instance: { refPath: "/Game/Main.Main:PersistentLevel.PostProcessVolume_0" } }) === 3,
	);

	// values 字符串 → tier（属性名匹配）
	check(
		"2.6 values 'temperature' → 1",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, values: '{"temperature": 4300}' }) === 1,
	);
	check(
		"2.7 values 'whiteTemp' → 3",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, values: '{"whiteTemp": 6500}' }) === 3,
	);

	// properties 对象 key → tier
	check(
		"2.8 properties 'colorSaturation' → 3",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, properties: { colorSaturation: 1.2 } }) === 3,
	);
	check(
		"2.9 properties 'fogDensity' → 2",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, properties: { fogDensity: 0.02 } }) === 2,
	);

	// 无匹配 → null
	check(
		"2.10 无匹配 → null",
		resolveTier(SET_PROPS, { instance: { refPath: "/x" }, values: '{"unknownProp": 1}' }) === null,
	);
	check("2.11 空参数 → null", resolveTier("SomeTool", {}) === null);

	// ── Test 3: nextTier 顺序 ──
	console.log("\n── Test 3: nextTier 顺序 ──");
	const n1 = nextTier(1);
	check("3.1 nextTier(1) → id 2 无 prePhase", n1?.id === 2 && n1.prePhase === undefined);
	const n2 = nextTier(2);
	check("3.2 nextTier(2) → prePhase=POSTPROCESS_SETUP", n2?.prePhase === "POSTPROCESS_SETUP");
	check("3.3 nextTier(3) → null", nextTier(3) === null);

	// ── Test 4: getTierDef / 渲染 ──
	console.log("\n── Test 4: getTierDef / 渲染 ──");
	check("4.1 getTierDef(1).label = 光源", getTierDef(1)?.label === "光源");
	check("4.2 getTierDef(99) → undefined", getTierDef(99) === undefined);
	check("4.3 buildTunableLine(1) 含 DirectionalLight", buildTunableLine(1).includes("DirectionalLight"));
	check("4.4 buildTunableLine(2) 含 SkyAtmosphere", buildTunableLine(2).includes("SkyAtmosphere"));
	check(
		"4.5 buildTierListDescription 3 行",
		(buildTierListDescription().match(/- Tier \d:/g) || []).length === 3,
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
