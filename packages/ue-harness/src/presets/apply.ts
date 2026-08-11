/**
 * Issue 008d — 预设属性应用
 *
 * 将预设的 components 属性批量设置到 UE 场景中。
 * 第一阶段：DirectionalLight transform（旋转）
 * 第二阶段：各组件属性（set_properties）
 */

import type { UeClient } from "../ue-client/mcp-client.ts";
import type { PresetEntry } from "./types.ts";

export interface ApplyResult {
	name: string;
	applied: Record<string, number>; // actor → 设置的属性数
	skipped: Record<string, string>; // actor → 跳过原因
}

/**
 * 将预设应用到当前 UE 场景。
 * 单线程顺序执行。
 */
export async function applyPreset(ueClient: UeClient, entry: PresetEntry): Promise<ApplyResult> {
	const setTransformName = "toolset_registry.toolsets.core.object.ObjectTools.set_actor_transform";
	const setPropsName = "toolset_registry.toolsets.core.object.ObjectTools.set_properties";

	const applied: Record<string, number> = {};
	const skipped: Record<string, string> = {};

	for (const [actorKey, actor] of Object.entries(entry.actors)) {
		try {
			// 第一阶段: DirectionalLight 旋转
			if (actor.transform) {
				const tResult = await ueClient.callTool(setTransformName, {
					instance: { refPath: actor.refPath },
					transform: actor.transform,
				});
				if (tResult.isError) {
					skipped[actorKey] = `set_actor_transform failed: ${tResult.text.substring(0, 100)}`;
					continue;
				}
			}

			// 第二阶段: 批量属性
			for (const [compKey, props] of Object.entries(actor.components)) {
				const propCount = Object.keys(props).length;
				if (propCount === 0) continue;

				const result = await ueClient.callTool(setPropsName, {
					instance: { refPath: actor.refPath },
					properties: props,
				});

				if (result.isError) {
					skipped[actorKey] = `set_properties(${compKey}) failed: ${result.text.substring(0, 100)}`;
				} else {
					applied[actorKey] = (applied[actorKey] || 0) + propCount;
				}
			}
		} catch (e) {
			skipped[actorKey] = `actor error: ${(e as Error).message}`;
		}
	}

	return { name: entry.name, applied, skipped };
}
