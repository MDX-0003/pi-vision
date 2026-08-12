/**
 * Issue 008b — 预设场景快照
 *
 * 调用 UE MCP 工具获取 5 类氛围组件当前属性。
 * 复用 atmosphere-whitelist.ts 的 ATMOSPHERE_COMPONENT_GLOBS 和 ATMOSPHERE_WHITELIST。
 * PostProcessVolume 不保存属性——仅在外层标记 postprocessReset。
 */

import type { UeToolCaller } from "../ue-client/types.ts";
import { ATMOSPHERE_COMPONENT_GLOBS, ATMOSPHERE_WHITELIST, type PropertyAnnotation } from "../tools/atmosphere-whitelist.ts";
import type { PresetActor } from "./types.ts";

export interface CaptureResult {
	actors: Record<string, PresetActor>;
	missingActors: string[];
}

// ── 复用 map-atmosphere 的辅助函数 ──

function parseUeReturnValue(text: string): unknown {
	try {
		const outer = JSON.parse(text);
		if (outer.returnValue !== undefined) {
			const rv = outer.returnValue;
			if (typeof rv === "string") {
				try {
					return JSON.parse(rv);
				} catch {
					return rv;
				}
			}
			return rv;
		}
		return outer;
	} catch {
		return text;
	}
}

function extractActorRefPaths(parsed: unknown): string[] {
	if (Array.isArray(parsed)) {
		return parsed.map((a: any) => a?.refPath || a?.path || String(a)).filter(Boolean);
	}
	return [];
}

/** 获取组件 refPath (Actor → get_properties of component keys → component refPath) */
async function resolveComponentRefPaths(
	caller: UeToolCaller,
	actorRefPath: string,
	componentKeys: string[],
): Promise<{ key: string; refPath: string }[]> {
	const gpName = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
	const result = await caller.callTool(gpName, {
		instance: { refPath: actorRefPath },
		properties: componentKeys,
	});
	if (result.isError) return [];

	const data = parseUeReturnValue(result.text);
	if (!data || typeof data !== "object") return [];

	const paths: { key: string; refPath: string }[] = [];
	for (const key of componentKeys) {
		if ((data as Record<string, unknown>)[key]?.refPath) {
			paths.push({ key, refPath: (data as Record<string, any>)[key].refPath });
		}
	}
	return paths;
}

// ═══════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════

/**
 * 快照当前场景中 5 类氛围组件的属性。
 * PostProcessVolume 跳过（不存属性，仅标记 postprocessReset）。
 */
export async function capturePresetState(caller: UeToolCaller): Promise<CaptureResult> {
	const findActorsName = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";
	const listPropsName = "toolset_registry.toolsets.core.object.ObjectTools.list_properties";
	const getPropsName = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
	const getTransformName = "toolset_registry.toolsets.core.object.ObjectTools.get_actor_transform";

	const actors: Record<string, PresetActor> = {};
	const missingActors: string[] = [];

	// 只处理前 5 个（排除 PostProcessVolume，tier=3）
	const componentConfigs = ATMOSPHERE_COMPONENT_GLOBS.filter((cfg) => cfg.label !== "POSTPROCESS");

	for (const cfg of componentConfigs) {
		// Step 1: find_actors
		const faResult = await caller.callTool(findActorsName, { glob: cfg.glob, tag: "" });
		if (faResult.isError) continue;

		const found = parseUeReturnValue(faResult.text);
		const actorRefPaths = extractActorRefPaths(found);

		if (actorRefPaths.length === 0) {
			missingActors.push(cfg.actorClass);
			continue;
		}

		for (const actorRefPath of actorRefPaths) {
			// Step 2: 获取组件 refPath
			let resolvedRefPath: string;
			let compClass: string;

			if (cfg.compKeys.length === 0) {
				// 无子组件键（如 PostProcessVolume）→ 直接用 actor refPath
				resolvedRefPath = actorRefPath;
				compClass = cfg.compClass;
			} else {
				const compRefs = await resolveComponentRefPaths(caller, actorRefPath, cfg.compKeys);
				if (compRefs.length === 0) continue;
				resolvedRefPath = compRefs[0].refPath;
				compClass = cfg.compClass;
			}

			// Step 3: list_properties on the resolved path
			const lpResult = await caller.callTool(listPropsName, {
				instance: { refPath: resolvedRefPath },
			});
			if (lpResult.isError) continue;

			const compProps = parseUeReturnValue(lpResult.text);
			if (typeof compProps !== "object" || compProps === null) continue;

			// Step 4: 匹配 whitelist → 读取属性值
			const relevantProps: PropertyAnnotation[] = ATMOSPHERE_WHITELIST.filter(
				(a) => a.componentClass === compClass,
			);
			const propNames = [...new Set(relevantProps.map((a) => a.property))];

			if (propNames.length === 0) continue;

			let propValues: Record<string, unknown>;
			try {
				const gvResult = await caller.callTool(getPropsName, {
					instance: { refPath: resolvedRefPath },
					properties: propNames,
				});
				if (gvResult.isError) continue;
				propValues = (parseUeReturnValue(gvResult.text) as Record<string, unknown>) ?? {};
			} catch {
				continue;
			}

			// Step 5: DirectionalLight 需要 transform
			let transform: { rotation: { Pitch: number; Yaw: number; Roll: number } } | undefined;
			if (cfg.actorClass === "DirectionalLight") {
				try {
					const gtResult = await caller.callTool(getTransformName, {
						instance: { refPath: actorRefPath },
					});
					if (!gtResult.isError) {
						const gtData = parseUeReturnValue(gtResult.text);
						if (gtData && typeof gtData === "object") {
							const rot = (gtData as any).rotation;
							if (rot) {
								transform = {
									rotation: {
										Pitch: Number(rot.Pitch ?? rot.pitch ?? 0),
										Yaw: Number(rot.Yaw ?? rot.yaw ?? 0),
										Roll: Number(rot.Roll ?? rot.roll ?? 0),
									},
								};
							}
						}
					}
				} catch {
					/* transform 不是必须的 */
				}
			}

			// 组装 PresetActor
			const actorShort = actorRefPath.split(":").pop() || actorRefPath;
			actors[actorShort] = {
				refPath: actorRefPath,
				transform,
				components: {
					[compClass]: propValues,
				},
			};
		}
	}

	return { actors, missingActors };
}
