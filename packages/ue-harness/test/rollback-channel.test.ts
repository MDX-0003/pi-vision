/**
 * Issue 012 — applyRollback 按通道分派测试 (mock UeToolCaller)
 *
 * 验证三条 UE 写路径的工具选择与参数形状:
 *   transform   → set_actor_transform + { actor, transform }
 *   values      → set_properties + { instance, values: JSON.stringify(...) }
 *   properties  → set_properties + { instance, properties }
 * 以及 isError 时不计入 applied (不误报"已回滚")。
 *
 * 运行: node --import tsx test/rollback-channel.test.ts (packages/ue-harness 目录)
 */

import { applyRollback } from "../src/workflow/rollback.ts";
import type { RollbackWrite } from "../src/workflow/phase-machine.ts";
import type { McpCallResult, UeToolCaller } from "../src/ue-client/types.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) {
		console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

interface CallRecord {
	name: string;
	args: Record<string, unknown>;
}

/** 按调用顺序返回预设结果的 mock caller (同时记录每次调用) */
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
	console.log("Issue 012 — applyRollback channel dispatch");
	console.log("=".repeat(60));

	const OK: McpCallResult = { text: "{}", isError: false };
	const ERR: McpCallResult = { text: "boom", isError: true };

	// ── Test 1: transform 通道 ──
	console.log("\n── Test 1: transform 通道 ──");
	const transform = { location: { x: 0, y: 0, z: 0 }, rotation: { Pitch: 0, Yaw: 45, Roll: 0 }, scale: { x: 1, y: 1, z: 1 } };
	const t1 = createMockCaller([OK]);
	const w1: RollbackWrite[] = [{ refPath: "/Game/Main.Main:PersistentLevel.DirectionalLight_0", channel: "transform", props: { transform } }];
	const n1 = await applyRollback(t1.caller, w1);
	check("1.1 工具 = set_actor_transform", t1.calls[0]?.name.endsWith("set_actor_transform") === true, t1.calls[0]?.name);
	check("1.2 参数 = { actor, xform } (实机 schema: xform 不是 transform)", (t1.calls[0]?.args.actor as { refPath: string })?.refPath === w1[0].refPath && (t1.calls[0]?.args.xform as Record<string, unknown>)?.rotation !== undefined);
	check("1.3 返回提示含已回滚 1/1", n1 !== null && n1.includes("1/1"));

	// ── Test 2: values 通道 (PPV settings struct) ──
	console.log("\n── Test 2: values 通道 ──");
	const t2 = createMockCaller([OK]);
	const w2: RollbackWrite[] = [{ refPath: "/Game/Main.Main:PersistentLevel.PostProcessVolume_0", channel: "values", props: { settings: { WhiteTemp: 6500, ColorSaturation: { r: 1, g: 1, b: 1 } } } }];
	const n2 = await applyRollback(t2.caller, w2);
	check("2.1 工具 = set_properties", t2.calls[0]?.name.endsWith("set_properties") === true);
	const v2 = t2.calls[0]?.args.values;
	check("2.2 values 是 JSON 字符串", typeof v2 === "string");
	check("2.3 values 可反序列化为原 props", typeof v2 === "string" && JSON.parse(v2).settings?.WhiteTemp === 6500);
	check("2.4 instance.refPath 正确", (t2.calls[0]?.args.instance as { refPath: string })?.refPath === w2[0].refPath);

	// ── Test 3: properties 通道 (常规组件) ──
	console.log("\n── Test 3: properties 通道 ──");
	const t3 = createMockCaller([OK]);
	const w3: RollbackWrite[] = [{ refPath: "/Game/Main.Main:PersistentLevel.DirectionalLight_0", channel: "properties", props: { intensity: 10, temperature: 6500 } }];
	const n3 = await applyRollback(t3.caller, w3);
	check("3.1 工具 = set_properties", t3.calls[0]?.name.endsWith("set_properties") === true);
	const v3 = t3.calls[0]?.args.values;
	check("3.2 properties 通道统一走 values JSON 字符串", typeof v3 === "string" && (JSON.parse(v3 as string) as Record<string, unknown>)?.intensity === 10);
	check("3.3 无 properties 字段", t3.calls[0]?.args.properties === undefined);

	// ── Test 4: isError → 不计入 applied ──
	console.log("\n── Test 4: isError 不计入 ──");
	const t4 = createMockCaller([ERR, OK]);
	const w4: RollbackWrite[] = [
		{ refPath: "/a", channel: "properties", props: { intensity: 10 } },
		{ refPath: "/b", channel: "properties", props: { intensity: 20 } },
	];
	const n4 = await applyRollback(t4.caller, w4);
	check("4.1 调用 2 次", t4.calls.length === 2);
	check("4.2 只记成功 1 个 → 提示 1/2", n4 !== null && n4.includes("1/2"), n4 ?? "null");

	// ── Test 5: 全部失败 → null (不误报已回滚) ──
	console.log("\n── Test 5: 全部失败 ──");
	const t5 = createMockCaller([ERR]);
	const n5 = await applyRollback(t5.caller, w4);
	check("5.1 返回 null", n5 === null);

	// ── Test 6: 空写 → 无调用 ──
	console.log("\n── Test 6: 空写 ──");
	const t6 = createMockCaller([OK]);
	const n6 = await applyRollback(t6.caller, []);
	check("6.1 返回 null", n6 === null);
	check("6.2 零调用", t6.calls.length === 0);

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ rollback channel dispatch 全部通过");
	console.log("=".repeat(60));
}

main().catch((err) => {
	console.error("FATAL:", (err as Error).message);
	process.exit(1);
});
