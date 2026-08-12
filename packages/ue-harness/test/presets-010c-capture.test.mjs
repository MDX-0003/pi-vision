/**
 * Issue 010c — capturePresetState mock 单元测试
 *
 * 运行: node --experimental-vm-modules test/presets-010c-capture.test.mjs
 */

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
	if (condition) {
		console.log(`\x1b[32m${PASS}\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`\x1b[31m${FAIL}\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

// ═══════════════════════════════════════════
// Inline simplified capturePresetState
// ═══════════════════════════════════════════

const ATMOSPHERE_COMPONENT_GLOBS = [
	{ glob: "*DirectionalLight*",    actorClass: "DirectionalLight",     compKeys: ["directionalLightComponent"],    compClass: "DirectionalLightComponent" },
	{ glob: "*SkyLight*",            actorClass: "SkyLight",             compKeys: ["lightComponent"],               compClass: "SkyLightComponent" },
	{ glob: "*SkyAtmosphere*",       actorClass: "SkyAtmosphere",        compKeys: ["skyAtmosphereComponent"],       compClass: "SkyAtmosphereComponent" },
	{ glob: "*ExponentialHeightFog*",actorClass: "ExponentialHeightFog", compKeys: ["component"],                     compClass: "ExponentialHeightFogComponent" },
	{ glob: "*VolumetricCloud*",     actorClass: "VolumetricCloud",      compKeys: ["volumetricCloudComponent"],     compClass: "VolumetricCloudComponent" },
];

const ATMOSPHERE_WHITELIST = [
	{ property: "lightColor",         componentClass: "DirectionalLightComponent" },
	{ property: "intensity",          componentClass: "DirectionalLightComponent" },
	{ property: "lightColor",         componentClass: "SkyLightComponent" },
	{ property: "intensity",          componentClass: "SkyLightComponent" },
	{ property: "rayleighScatteringColor", componentClass: "SkyAtmosphereComponent" },
	{ property: "fogDensity",         componentClass: "ExponentialHeightFogComponent" },
	{ property: "layerBottomAltitude",componentClass: "VolumetricCloudComponent" },
	{ property: "layerHeight",        componentClass: "VolumetricCloudComponent" },
];

function parseUeReturnValue(text) {
	try {
		const outer = JSON.parse(text);
		if (outer && outer.returnValue !== undefined) {
			const rv = outer.returnValue;
			if (typeof rv === "string") {
				try { return JSON.parse(rv); } catch { return rv; }
			}
			return rv;
		}
		return outer;
	} catch { return text; }
}

function extractActorRefPaths(parsed) {
	if (Array.isArray(parsed)) {
		return parsed.map((a) => a?.refPath || a?.path || String(a)).filter(Boolean);
	}
	return [];
}

async function capturePresetState(mockCall) {
	const findActorsName = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";
	const listPropsName = "toolset_registry.toolsets.core.object.ObjectTools.list_properties";
	const getPropsName = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
	const getTransformName = "toolset_registry.toolsets.core.object.ObjectTools.get_actor_transform";

	const actors = {};
	const missingActors = [];

	for (const cfg of ATMOSPHERE_COMPONENT_GLOBS) {
		const faResult = await mockCall(findActorsName, { glob: cfg.glob, tag: "" });
		if (faResult.isError) continue;

		const found = parseUeReturnValue(faResult.text);
		const actorRefPaths = extractActorRefPaths(found);

		if (actorRefPaths.length === 0) {
			missingActors.push(cfg.actorClass);
			continue;
		}

		for (const actorRefPath of actorRefPaths) {
			// resolve component refPath
			let resolvedRefPath;
			if (cfg.compKeys.length === 0) {
				resolvedRefPath = actorRefPath;
			} else {
				const resolveResult = await mockCall(getPropsName, {
					instance: { refPath: actorRefPath },
					properties: cfg.compKeys,
				});
				if (resolveResult.isError) continue;
				const compData = parseUeReturnValue(resolveResult.text);
				if (!compData || typeof compData !== "object") continue;
				resolvedRefPath = "";
				for (const key of cfg.compKeys) {
					if (compData[key]?.refPath) { resolvedRefPath = compData[key].refPath; break; }
				}
				if (!resolvedRefPath) continue;
			}

			// list_properties
			const lpResult = await mockCall(listPropsName, {
				instance: { refPath: resolvedRefPath },
			});
			if (lpResult.isError) continue;
			const compProps = parseUeReturnValue(lpResult.text);
			if (typeof compProps !== "object" || compProps === null) continue;

			// whitelist filter
			const relevantProps = ATMOSPHERE_WHITELIST.filter((a) => a.componentClass === cfg.compClass);
			const propNames = [...new Set(relevantProps.map((a) => a.property))];
			if (propNames.length === 0) continue;

			// get_properties
			const gvResult = await mockCall(getPropsName, {
				instance: { refPath: resolvedRefPath },
				properties: propNames,
			});
			if (gvResult.isError) continue;
			const propValues = parseUeReturnValue(gvResult.text) ?? {};

			// transform (DirectionalLight only)
			let transform;
			if (cfg.actorClass === "DirectionalLight") {
				try {
					const gtResult = await mockCall(getTransformName, {
						instance: { refPath: actorRefPath },
					});
					if (!gtResult.isError) {
						const gtData = parseUeReturnValue(gtResult.text);
						if (gtData && typeof gtData === "object" && gtData.rotation) {
							transform = {
								rotation: {
									Pitch: Number(gtData.rotation.Pitch ?? gtData.rotation.pitch ?? 0),
									Yaw: Number(gtData.rotation.Yaw ?? gtData.rotation.yaw ?? 0),
									Roll: Number(gtData.rotation.Roll ?? gtData.rotation.roll ?? 0),
								},
							};
						}
					}
				} catch { /* not required */ }
			}

			const actorShort = actorRefPath.split(":").pop() || actorRefPath;
			actors[actorShort] = {
				refPath: actorRefPath,
				transform,
				components: { [cfg.compClass]: propValues },
			};
		}
	}

	return { actors, missingActors };
}

// ═══════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════

/** Wrap data in UE's double-JSON format: { returnValue: JSON.stringify(data) } */
function rv(data) {
	return { text: JSON.stringify({ returnValue: JSON.stringify(data) }), isError: false };
}
function err(text) {
	return { text: text || "error", isError: true, errorType: "server_error" };
}

// Short tool names used as dispatch keys
const FN = { FA: "find_actors", LP: "list_properties", GP: "get_properties", GT: "get_actor_transform" };

/** Build a named mock: callTool(name, params) → dispatch by name */
function createMock(handlers) {
	return async (name, params) => {
		// Extract short name from full UE tool path (e.g. "...find_actors" → "find_actors")
		const short = name.split(".").pop();
		const handler = handlers[short];
		if (!handler) return err(`unexpected: ${name}`);
		return handler(params);
	};
}

// ═══════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════

console.log("\n── capturePresetState() mock tests ──\n");

async function runTests() {

// Case 1: 空场景 — 所有 find_actors 返回 []
{
	const mock = createMock({
		[FN.FA]: () => rv([]),
	});
	const result = await capturePresetState(mock);
	check("1. empty → actors={}", Object.keys(result.actors).length === 0);
	check("1. empty → 5 missing", result.missingActors.length === 5);
	check("1. empty → DirectionalLight in missing", result.missingActors.includes("DirectionalLight"));
}

// Case 2: find_actors error → 静默跳过，不记 missing
{
	let callIdx = 0;
	const mock = createMock({
		[FN.FA]: () => {
			callIdx++;
			return callIdx === 1 ? err("timeout") : rv([]);
		},
	});
	const result = await capturePresetState(mock);
	check("2. fa error → actors={}", Object.keys(result.actors).length === 0);
	check("2. fa error → NOT in missing", !result.missingActors.includes("DirectionalLight"));
	check("2. fa error → other 4 missing", result.missingActors.length === 4);
}

// Case 3: resolveComponentRefPaths 返回空 → 跳过
{
	const r = "/Game/L.Level:PersistentLevel";
	const mock = createMock({
		[FN.FA]: (p) => p.glob === "*DirectionalLight*" ? rv([{ refPath: `${r}.DirLight_0` }]) : rv([]),
		[FN.GP]: () => rv({}),  // no refPath found → resolve empty
	});
	const result = await capturePresetState(mock);
	check("3. resolve empty → DirLight not captured", !result.actors["DirLight_0"]);
	check("3. resolve empty → 4 missing", result.missingActors.length === 4);
}

// Case 4: list_properties error → 跳过
{
	const r = "/Game/L.Level:PersistentLevel";
	let callCount = 0;
	const mock = createMock({
		[FN.FA]: (p) => p.glob === "*VolumetricCloud*" ? rv([{ refPath: `${r}.VolCloud_0` }]) : rv([]),
		[FN.GP]: (p) => {
			if (Array.isArray(p.properties) && p.properties.includes("volumetricCloudComponent")) {
				return rv({ "volumetricCloudComponent": { refPath: `${r}.VolCloud_0.volumetricCloudComponent` } });
			}
			return rv({});
		},
		[FN.LP]: (p) => {
			if (p.instance.refPath.includes("volumetricCloudComponent")) return err("list failed");
			return rv({});
		},
	});
	const result = await capturePresetState(mock);
	check("4. list error → VolCloud not captured", !result.actors["VolCloud_0"]);
}

// Case 5: get_properties error → 跳过
{
	const r = "/Game/L.Level:PersistentLevel";
	let getCalled = false;
	const mock = createMock({
		[FN.FA]: (p) => p.glob === "*SkyLight*" ? rv([{ refPath: `${r}.SkyLight_0` }]) : rv([]),
		[FN.GP]: (p) => {
			if (Array.isArray(p.properties) && p.properties.includes("lightComponent")) {
				return rv({ "lightComponent": { refPath: `${r}.SkyLight_0.lightComponent` } });
			}
			// 2nd get_properties call → error
			if (Array.isArray(p.properties) && p.properties.includes("lightColor")) {
				getCalled = true;
				return err("get failed");
			}
			return rv({});
		},
		[FN.LP]: () => rv({ lightColor: {}, intensity: {} }),
	});
	const result = await capturePresetState(mock);
	check("5. get error → SkyLight not captured", !result.actors["SkyLight_0"]);
}

// Case 6: DirectionalLight transform 失败 → 仍捕获（无 transform）
{
	const r = "/Game/L.Level:PersistentLevel";
	const mock = createMock({
		[FN.FA]: (p) => p.glob === "*DirectionalLight*" ? rv([{ refPath: `${r}.DirLight_0` }]) : rv([]),
		[FN.GP]: (p) => {
			if (Array.isArray(p.properties) && p.properties.includes("directionalLightComponent"))
				return rv({ "directionalLightComponent": { refPath: `${r}.DirLight_0.directionalLightComponent` } });
			if (Array.isArray(p.properties) && p.properties.includes("lightColor"))
				return rv({ lightColor: { r: 1, g: 0.9, b: 0.8, a: 1 }, intensity: 10 });
			return rv({});
		},
		[FN.LP]: () => rv({ lightColor: {}, intensity: {} }),
		[FN.GT]: () => err("transform timeout"),
	});
	const result = await capturePresetState(mock);
	const d6 = Object.values(result.actors).find(a => a.refPath.includes("DirLight_0"));
	check("6. transform error → DirLight captured", !!d6);
	check("6. transform error → transform undefined", d6?.transform === undefined);
	check("6. transform error → lightColor.r=1", d6?.components?.DirectionalLightComponent?.lightColor?.r === 1);
}

// Case 7: 完整场景 — 5 actors 全捕获
{
	const r = "/Game/L.Level:PersistentLevel";
	let findCall = 0;
	const mock = createMock({
		[FN.FA]: () => {
			const names = ["DirectionalLight_0", "SkyLight_0", "SkyAtmosphere_0", "ExponentialHeightFog_0", "VolumetricCloud_0"];
			const idx = findCall++;
			if (idx >= names.length) return rv([]);
			return rv([{ refPath: `${r}.${names[idx]}` }]);
		},
		[FN.GP]: (p) => {
			const ref = p.instance?.refPath || "";
			if (ref.includes("DirectionalLight_0") && !ref.includes("directionalLightComponent"))
				return rv({ "directionalLightComponent": { refPath: `${r}.DirectionalLight_0.directionalLightComponent` } });
			if (ref.includes("directionalLightComponent"))
				return rv({ lightColor: { r: 1, g: 1, b: 1, a: 1 }, intensity: 10 });
			if (ref.includes("SkyLight_0") && !ref.includes("lightComponent"))
				return rv({ "lightComponent": { refPath: `${r}.SkyLight_0.lightComponent` } });
			if (ref.includes("lightComponent"))
				return rv({ lightColor: { r: 0.8, g: 0.9, b: 1, a: 1 }, intensity: 0.5 });
			if (ref.includes("SkyAtmosphere_0") && !ref.includes("skyAtmosphereComponent"))
				return rv({ "skyAtmosphereComponent": { refPath: `${r}.SkyAtmosphere_0.skyAtmosphereComponent` } });
			if (ref.includes("skyAtmosphereComponent"))
				return rv({ rayleighScatteringColor: { r: 0, g: 0, b: 1, a: 1 } });
			if (ref.includes("ExponentialHeightFog_0") && !ref.includes("component"))
				return rv({ "component": { refPath: `${r}.ExponentialHeightFog_0.component` } });
			if (ref.includes("component"))
				return rv({ fogDensity: 0.02 });
			if (ref.includes("VolumetricCloud_0") && !ref.includes("volumetricCloudComponent"))
				return rv({ "volumetricCloudComponent": { refPath: `${r}.VolumetricCloud_0.volumetricCloudComponent` } });
			if (ref.includes("volumetricCloudComponent"))
				return rv({ layerBottomAltitude: 5, layerHeight: 10 });
			return rv({});
		},
		[FN.LP]: (p) => {
			const ref = p.instance?.refPath || "";
			if (ref.includes("directionalLightComponent")) return rv({ lightColor: {}, intensity: {} });
			if (ref.includes("lightComponent")) return rv({ lightColor: {}, intensity: {} });
			if (ref.includes("skyAtmosphereComponent")) return rv({ rayleighScatteringColor: {} });
			if (ref.includes("component")) return rv({ fogDensity: {} });
			if (ref.includes("volumetricCloudComponent")) return rv({ layerBottomAltitude: {}, layerHeight: {} });
			return rv({});
		},
		[FN.GT]: (p) => {
			if (p.instance?.refPath.includes("DirectionalLight_0"))
				return rv({ rotation: { Pitch: 0, Yaw: -45, Roll: 0 } });
			return rv({});
		},
	});
	const result = await capturePresetState(mock);
	check("7. full scene → 5 actors", Object.keys(result.actors).length === 5, `got ${Object.keys(result.actors).length}`);
	const d7_dir = Object.values(result.actors).find(a => a.refPath.includes("DirectionalLight_0"));
	const d7_sl = Object.values(result.actors).find(a => a.refPath.includes("SkyLight_0"));
	const d7_vc = Object.values(result.actors).find(a => a.refPath.includes("VolumetricCloud_0"));
	check("7. DirLight transform Yaw=-45", d7_dir?.transform?.rotation?.Yaw === -45);
	check("7. SkyLight lightColor.r=0.8", d7_sl?.components?.SkyLightComponent?.lightColor?.r === 0.8);
	check("7. VolCloud layerHeight=10", d7_vc?.components?.VolumetricCloudComponent?.layerHeight === 10);
	check("7. no missingActors", result.missingActors.length === 0, `got ${result.missingActors}`);
}

// Case 8: 两个同类型 actor
{
	const r = "/Game/L.Level:PersistentLevel";
	let findCall = 0;
	const mock = createMock({
		[FN.FA]: () => {
			const idx = findCall++;
			if (idx === 0) return rv([{ refPath: `${r}.DirLight_0` }, { refPath: `${r}.DirLight_1` }]);
			return rv([]);
		},
		[FN.GP]: (p) => {
			const ref = p.instance?.refPath || "";
			const props = Array.isArray(p.properties) ? p.properties : [];
			// Resolve component refPaths
			if (props.includes("directionalLightComponent")) {
				if (ref.includes("DirLight_0")) return rv({ "directionalLightComponent": { refPath: `${r}.DirLight_0.dlc` } });
				if (ref.includes("DirLight_1")) return rv({ "directionalLightComponent": { refPath: `${r}.DirLight_1.dlc` } });
			}
			// Get property values
			if (props.includes("lightColor")) {
				if (ref.includes("DirLight_0.dlc")) return rv({ lightColor: { r: 1, g: 0.9, b: 0.8, a: 1 }, intensity: 10 });
				if (ref.includes("DirLight_1.dlc")) return rv({ lightColor: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, intensity: 5 });
			}
			return rv({});
		},
		[FN.LP]: () => rv({ lightColor: {}, intensity: {} }),
		[FN.GT]: (p) => {
			if (p.instance?.refPath.includes("DirLight_0")) return rv({ rotation: { Pitch: 0, Yaw: 0, Roll: 0 } });
			if (p.instance?.refPath.includes("DirLight_1")) return rv({ rotation: { Pitch: 0, Yaw: 90, Roll: 0 } });
			return rv({});
		},
	});
	const result = await capturePresetState(mock);
	check("8. two DirLights → 2 actors", Object.keys(result.actors).length === 2, `got ${Object.keys(result.actors).length}`);
	const d8_0 = Object.values(result.actors).find(a => a.refPath.includes("DirLight_0"));
	const d8_1 = Object.values(result.actors).find(a => a.refPath.includes("DirLight_1"));
	check("8. DirLight_0 intensity=10", d8_0?.components?.DirectionalLightComponent?.intensity === 10);
	check("8. DirLight_1 intensity=5", d8_1?.components?.DirectionalLightComponent?.intensity === 5);
	check("8. DirLight_1 Yaw=90", d8_1?.transform?.rotation?.Yaw === 90);
}

// Case 9: DirectionalLight 无 whitelist 匹配属性 → 跳过
{
	const r = "/Game/L.Level:PersistentLevel";
	const mock = createMock({
		[FN.FA]: (p) => p.glob === "*DirectionalLight*" ? rv([{ refPath: `${r}.DirLight_0` }]) : rv([]),
		[FN.GP]: (p) => {
			if (Array.isArray(p.properties) && p.properties.includes("directionalLightComponent"))
				return rv({ "directionalLightComponent": { refPath: `${r}.DirLight_0.dlc` } });
			return rv({});
		},
		// list_properties returns props NOT in whitelist for this componentClass
		[FN.LP]: () => rv({ nonWhitelistProp: {} }),
	});
	const result = await capturePresetState(mock);
	check("9. no whitelist match → DirLight not captured", !result.actors["DirLight_0"]);
}

// Case 10: list_properties 返回非 object → 跳过
{
	const r = "/Game/L.Level:PersistentLevel";
	const mock = createMock({
		[FN.FA]: (p) => p.glob === "*SkyLight*" ? rv([{ refPath: `${r}.SkyLight_0` }]) : rv([]),
		[FN.GP]: (p) => {
			if (Array.isArray(p.properties) && p.properties.includes("lightComponent"))
				return rv({ "lightComponent": { refPath: `${r}.SkyLight_0.lightComponent` } });
			return rv({});
		},
		[FN.LP]: () => rv("not_an_object"),
	});
	const result = await capturePresetState(mock);
	check("10. list returns string → SkyLight not captured", !result.actors["SkyLight_0"]);
}

} // end runTests

await runTests();

// Summary
console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`\x1b[31m${FAIL}\x1b[0m ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`\x1b[32m${PASS}\x1b[0m All capture mock tests passed!`);
}
