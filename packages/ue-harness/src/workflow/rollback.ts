/**
 * Issue 012 — 回滚写执行器
 *
 * 从 index.ts 抽取，通过 UeToolCaller 可 mock 测试 (同 apply.ts / capture.ts 模式)。
 *
 * 实机验证 (2026-08-14, UE MCP schema):
 *   - set_properties 只接受 { instance, values: string }，没有 properties 参数 ——
 *     常规组件与 PPV 一律 values JSON 字符串 (常规: {"intensity":6}, PPV: {"settings":{...}})
 *   - set_actor_transform 的参数名是 xform (不是 transform)，rotation 字段为小写 pitch/yaw/roll
 *
 * 背景: 旧 applyRollback 用 properties object / transform 参数，实机全部失败 (server_error)。
 * 修复: 统一按 UE 实际 schema 写回。
 */

import type { UeToolCaller } from "../ue-client/types.ts";
import type { RollbackWrite } from "./phase-machine.ts";

const SET_PROPS_TOOL = "toolset_registry.toolsets.core.object.ObjectTools.set_properties";
const SET_TRANSFORM_TOOL = "toolset_registry.toolsets.core.actor.ActorTools.set_actor_transform";

/**
 * 将回滚写应用到 UE (按 channel 分派工具与参数形状)。
 * 返回 null 表示全部失败或无写; 否则返回注入到 tool_result 的提示文本。
 */
export async function applyRollback(
	caller: UeToolCaller,
	writes: RollbackWrite[],
): Promise<string | null> {
	if (writes.length === 0) return null;

	let applied = 0;
	for (const w of writes) {
		const tool = w.channel === "transform" ? SET_TRANSFORM_TOOL : SET_PROPS_TOOL;
		// 实机 schema: set_properties 只接受 values JSON 字符串 (properties/properties 通道统一)；
		// set_actor_transform 的参数名是 xform (不是 transform)
		const args = w.channel === "transform"
			? { actor: { refPath: w.refPath }, xform: w.props.transform }
			: { instance: { refPath: w.refPath }, values: JSON.stringify(w.props) };
		const r = await caller.callTool(tool, args);
		if (!r.isError) applied++;
	}
	if (applied === 0) return null;
	return `\n[ue-harness] 检测到停滞，已回滚 ${applied}/${writes.length} 个 actor 到历史最佳参数。`;
}
