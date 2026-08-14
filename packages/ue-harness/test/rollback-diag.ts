/**
 * Issue 012 — 回滚通道实机诊断脚本
 *
 * 验证 applyRollback 的写路径在真实 UE MCP 上是否生效 (2026-08-14 实测):
 *   1. properties 写: set_properties + values JSON 字符串 (常规组件, 组件 refPath)
 *   2. transform 写: set_actor_transform + xform (注意参数名是 xform, rotation 小写 pitch/yaw/roll)
 *   3. values 写 (PPV): set_properties + values JSON 字符串 {"settings":{...}}
 * 以及 get_properties 读回的 settings struct 字段名 (PascalCase, 如 WhiteTemp)
 * 与 values 写入时的字段名是否一致 —— 决定 journal 的 from 值能否直接写回。
 *
 * 运行 (需要 UE 运行 + MCP :8000):
 *   node --import tsx test/rollback-diag.ts
 *
 * 安全: 每项测试都会恢复原值 (读前记录, 测后写回)。
 */

import { UeClient } from "../src/ue-client/mcp-client.ts";

const DIAG = "[DIAG]";

const FIND_ACTORS = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";
const GET_PROPS = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
const SET_PROPS = "toolset_registry.toolsets.core.object.ObjectTools.set_properties";
const GET_TRANSFORM = "toolset_registry.toolsets.core.actor.ActorTools.get_actor_transform";
const SET_TRANSFORM = "toolset_registry.toolsets.core.actor.ActorTools.set_actor_transform";

function parseValue(text: string): unknown {
	try {
		const outer = JSON.parse(text);
		if (outer.returnValue !== undefined) {
			const rv = outer.returnValue;
			if (typeof rv === "string") {
				try { return JSON.parse(rv); } catch { return rv; }
			}
			return rv;
		}
		return outer;
	} catch {
		return text;
	}
}

function extractRefPaths(parsed: unknown): string[] {
	if (Array.isArray(parsed)) {
		return parsed.map((a: unknown) => {
			const o = a as { refPath?: string; path?: string };
			return o?.refPath || o?.path || String(a);
		}).filter(Boolean);
	}
	return [];
}

async function findFirstActor(ue: UeClient, glob: string): Promise<string | null> {
	const r = await ue.callTool(FIND_ACTORS, { glob, tag: "" });
	if (r.isError) {
		console.log(`${DIAG}   ✗ find_actors(${glob}) → ERROR: ${r.text.slice(0, 200)}`);
		return null;
	}
	const paths = extractRefPaths(parseValue(r.text));
	console.log(`${DIAG}   find_actors(${glob}) → ${paths.length} actor(s)`);
	return paths[0] ?? null;
}

/** 通过 get_properties(actor, componentKeys) 解析组件 refPath (同 capture.ts) */
async function resolveComponent(ue: UeClient, actorPath: string, keys: string[]): Promise<string | null> {
	const r = await ue.callTool(GET_PROPS, { instance: { refPath: actorPath }, properties: keys });
	if (r.isError) return null;
	const data = parseValue(r.text) as Record<string, unknown>;
	for (const k of keys) {
		const refPath = (data?.[k] as { refPath?: string } | undefined)?.refPath;
		if (refPath) return refPath;
	}
	return null;
}

async function main() {
	console.log(`${DIAG} === rollback channel diagnostic ===`);
	const ue = new UeClient({ ueMcpUrl: process.env.UE_MCP_URL || "http://localhost:8000/mcp" });

	try {
		await ue.connect();
		console.log(`${DIAG} Connected to UE MCP at ${process.env.UE_MCP_URL || "http://localhost:8000/mcp"}`);
	} catch (e) {
		console.error(`${DIAG} Failed to connect: ${(e as Error).message}`);
		process.exit(1);
	}

	try {
		const all = await ue.listAllTools();
		console.log(`${DIAG} Toolsets loaded: ${all.length} tools`);
	} catch (e) {
		console.error(`${DIAG} listAllTools failed: ${(e as Error).message}`);
		process.exit(1);
	}

	// ── 1. properties 通道 (常规组件, 组件 refPath) ──
	console.log(`${DIAG} --- properties 通道 ---`);
	const dlActor = await findFirstActor(ue, "*DirectionalLight*");
	let dlComp: string | null = null;
	if (dlActor) {
		dlComp = await resolveComponent(ue, dlActor, ["directionalLightComponent", "lightComponent"]);
		console.log(`${DIAG}   component refPath: ${dlComp ?? "(解析失败)"}`);
	}
	if (dlComp) {
		const getR = await ue.callTool(GET_PROPS, { instance: { refPath: dlComp }, properties: ["intensity"] });
		const got = parseValue(getR.text) as Record<string, unknown>;
		const orig = got?.intensity as number | undefined;
		console.log(`${DIAG}   get_properties(intensity) → ${orig ?? "(读取失败)"}  [raw: ${getR.text.slice(0, 120)}]`);
		if (typeof orig === "number") {
			const testVal = orig + 1;
			// 实机 schema: set_properties 只接受 values JSON 字符串
			const setR = await ue.callTool(SET_PROPS, { instance: { refPath: dlComp }, values: JSON.stringify({ intensity: testVal }) });
			const backR = await ue.callTool(GET_PROPS, { instance: { refPath: dlComp }, properties: ["intensity"] });
			const back = (parseValue(backR.text) as Record<string, unknown>)?.intensity;
			const ok = !setR.isError && back === testVal;
			console.log(`${ok ? "✓" : "✗"}   properties 写回生效: set ${testVal} → 读回 ${back} ${ok ? "" : `(set isError=${setR.isError})`}`);
			await ue.callTool(SET_PROPS, { instance: { refPath: dlComp }, values: JSON.stringify({ intensity: orig }) });
			console.log(`${DIAG}   restored intensity → ${orig}`);
		} else {
			console.log(`${DIAG}   ✗ intensity 读取失败 (组件路径? 字段名?)`);
		}
	} else {
		console.log(`${DIAG}   ✗ 未找到 DirectionalLight 组件, 跳过 properties 通道`);
	}

	// ── 2. transform 通道 (小写 pitch/yaw/roll) ──
	console.log(`${DIAG} --- transform 通道 ---`);
	if (dlActor) {
		const getR = await ue.callTool(GET_TRANSFORM, { actor: { refPath: dlActor } });
		const tf = parseValue(getR.text) as { rotation?: Record<string, unknown> } | null;
		console.log(`${DIAG}   get_actor_transform rotation → ${JSON.stringify(tf?.rotation ?? "(无)")}`);
		if (tf && typeof tf === "object") {
			const rot = tf.rotation as Record<string, unknown> | undefined;
			const origYaw = rot?.yaw as number | undefined;
			if (typeof origYaw === "number") {
				const testTf = { ...tf, rotation: { ...rot, yaw: origYaw + 1 } };
				// 实机 schema: 参数名是 xform
				const setR = await ue.callTool(SET_TRANSFORM, { actor: { refPath: dlActor }, xform: testTf });
				const backR = await ue.callTool(GET_TRANSFORM, { actor: { refPath: dlActor } });
				const backYaw = ((parseValue(backR.text) as Record<string, unknown>)?.rotation as Record<string, unknown>)?.yaw;
				const ok = !setR.isError && typeof backYaw === "number" && Math.abs(backYaw - (origYaw + 1)) < 1e-6;
				console.log(`${ok ? "✓" : "✗"}   transform 写回生效: yaw ${origYaw} → ${origYaw + 1} → 读回 ${backYaw}`);
				await ue.callTool(SET_TRANSFORM, { actor: { refPath: dlActor }, xform: tf });
				console.log(`${DIAG}   restored yaw → ${origYaw}`);
			} else {
				console.log(`${DIAG}   ✗ yaw 读取失败 (rotation 字段名是 pitch/yaw/roll 小写, 当前: ${Object.keys(rot ?? {}).join(",")})`);
			}
		}
	}

	// ── 3. values 通道 (PPV settings struct) ──
	console.log(`${DIAG} --- values 通道 (PPV) ---`);
	const ppvPath = (await findFirstActor(ue, "*PostProcessVolume*")) ?? (await findFirstActor(ue, "*PostProcess*"));
	if (ppvPath) {
		const getR = await ue.callTool(GET_PROPS, { instance: { refPath: ppvPath }, properties: ["settings"] });
		const settings = (parseValue(getR.text) as Record<string, unknown>)?.settings as Record<string, unknown> | undefined;
		if (settings && typeof settings === "object") {
			const keys = Object.keys(settings);
			console.log(`${DIAG}   settings struct 字段 (前 20): ${keys.slice(0, 20).join(", ")}`);
			// 实机验证: 值字段小写 camelCase (whiteTemp), bOverride 标志 PascalCase (bOverride_WhiteTemp)
			console.log(`${DIAG}   whiteTemp=${settings.whiteTemp} bOverride_WhiteTemp=${settings.bOverride_WhiteTemp}`);
			const origWhiteTemp = settings.whiteTemp as number | undefined;
			if (typeof origWhiteTemp === "number") {
				const testSettings = { ...settings, whiteTemp: origWhiteTemp + 10, bOverride_WhiteTemp: true };
				const setR = await ue.callTool(SET_PROPS, { instance: { refPath: ppvPath }, values: JSON.stringify({ settings: testSettings }) });
				const backR = await ue.callTool(GET_PROPS, { instance: { refPath: ppvPath }, properties: ["settings"] });
				const back = ((parseValue(backR.text) as Record<string, unknown>)?.settings as Record<string, unknown>)?.whiteTemp;
				const ok = !setR.isError && back === origWhiteTemp + 10;
				console.log(`${ok ? "✓" : "✗"}   values 写回生效: whiteTemp ${origWhiteTemp} → ${origWhiteTemp + 10} → 读回 ${back}`);
				await ue.callTool(SET_PROPS, { instance: { refPath: ppvPath }, values: JSON.stringify({ settings }) });
				console.log(`${DIAG}   restored settings`);
			} else {
				console.log(`${DIAG}   ✗ whiteTemp 读取失败 (值字段应为小写 camelCase)`);
			}
		} else {
			console.log(`${DIAG}   ✗ settings 读取失败 (properties: ["settings"] 是否返回 struct?) [raw: ${getR.text.slice(0, 150)}]`);
		}
	} else {
		console.log(`${DIAG}   ✗ 场景中无 PostProcessVolume, values 通道无法验证 (需有 PPV 的场景)`);
	}

	await ue.disconnect();
	console.log(`${DIAG} === done ===`);
}

main().catch((err) => {
	console.error(`${DIAG} FATAL: ${(err as Error).message}`);
	process.exit(1);
});
