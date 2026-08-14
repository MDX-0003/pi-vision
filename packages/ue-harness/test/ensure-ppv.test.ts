/**
 * Issue 012 review — ensurePostProcessVolume 自动创建 PPV
 *
 * 场景无 PostProcessVolume 时, 扩展自动 add_to_scene_from_class 创建 (bUnbound),
 * 避免 LLM 自己建 actor 绕过 guard/journal。
 *
 * 运行: node --import tsx test/ensure-ppv.test.ts
 */

import { ensurePostProcessVolume } from "../src/tools/assess-lighting.ts";
import type { McpCallResult, UeToolCaller } from "../src/ue-client/types.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) { console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`); passed++; }
	else { console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

interface CallRecord { name: string; args: Record<string, unknown>; }

/** 按调用顺序返回预设结果的 mock caller */
function createMockCaller(results: McpCallResult[]): { caller: UeToolCaller; calls: CallRecord[] } {
	const calls: CallRecord[] = [];
	let i = 0;
	return {
		caller: {
			callTool: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				const r = results[Math.min(i, results.length - 1)];
				i++;
				return r;
			},
		} as UeToolCaller,
		calls,
	};
}

async function main() {
	console.log("=".repeat(60));
	console.log("ensurePostProcessVolume — auto-create PPV");
	console.log("=".repeat(60));

	// ── Test 1: 场景无 PPV → 自动创建 + bUnbound ──
	console.log("\n── Test 1: 无 PPV 自动创建 ──");
	const t1 = createMockCaller([
		{ text: "{\"returnValue\":[]}", isError: false },               // find_actors → 空
		{ text: "{\"returnValue\":{\"refPath\":\"/Game/Main.Main:PersistentLevel.PostProcessVolume_0\"}}", isError: false }, // add → refPath
		{ text: "{\"returnValue\":true}", isError: false },               // set bUnbound
	]);
	const paths1 = await ensurePostProcessVolume(t1.caller);
	check("1.1 返回新创建的 refPath", paths1.length === 1 && paths1[0].includes("PostProcessVolume_0"), paths1.join(","));
	check("1.2 调用了 add_to_scene_from_class", t1.calls.some(c => c.name.includes("add_to_scene_from_class")));
	const addCall = t1.calls.find(c => c.name.includes("add_to_scene_from_class"));
	check("1.3 add 参数 = PostProcessVolume actor_type", (addCall?.args.actor_type as { refPath?: string })?.refPath === "/Script/Engine.PostProcessVolume");
	const setCall = t1.calls.find(c => c.name.includes("set_properties"));
	check("1.4 设置 bUnbound=true", typeof setCall?.args.values === "string" && (JSON.parse(setCall.args.values as string) as { bUnbound?: boolean })?.bUnbound === true);

	// ── Test 2: 场景已有 PPV → 不创建, 直接返回 ──
	console.log("\n── Test 2: 已有 PPV 不创建 ──");
	const t2 = createMockCaller([
		{ text: "{\"returnValue\":[{\"refPath\":\"/Game/Main.Main:PersistentLevel.PostProcessVolume_1\"}]}", isError: false },
	]);
	const paths2 = await ensurePostProcessVolume(t2.caller);
	check("2.1 返回已有 PPV", paths2.length === 1 && paths2[0].includes("PostProcessVolume_1"));
	check("2.2 未调用 add_to_scene_from_class", !t2.calls.some(c => c.name.includes("add_to_scene_from_class")));

	// ── Test 3: 创建失败 → 返回空 ──
	console.log("\n── Test 3: 创建失败 ──");
	const t3 = createMockCaller([
		{ text: "{\"returnValue\":[]}", isError: false },
		{ text: "[server_error] Parameter error: cannot create", isError: false }, // add 失败 (文本错误)
	]);
	const paths3 = await ensurePostProcessVolume(t3.caller);
	check("3.1 返回空列表", paths3.length === 0);

	// ── Test 4: find_actors 失败也走创建路径 ──
	console.log("\n── Test 4: find 失败仍尝试创建 ──");
	const t4 = createMockCaller([
		{ text: "[server_error] boom", isError: false },
		{ text: "{\"returnValue\":{\"refPath\":\"/Game/x.PostProcessVolume_9\"}}", isError: false },
		{ text: "{\"returnValue\":true}", isError: false },
	]);
	const paths4 = await ensurePostProcessVolume(t4.caller);
	check("4.1 find 失败后仍创建成功", paths4.length === 1 && paths4[0].includes("PostProcessVolume_9"));

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ ensurePostProcessVolume 全部通过");
	console.log("=".repeat(60));
}

main().catch((err) => { console.error("FATAL:", (err as Error).message); process.exit(1); });
