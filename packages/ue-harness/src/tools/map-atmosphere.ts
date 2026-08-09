/**
 * Issue 004 — map_atmosphere 工具实现
 *
 * 扫描场景中 6 类氛围组件，发现每个组件上的氛围相关属性，
 * 按 Tier 排列输出维度→UE属性映射表。
 *
 * 流程:
 *   find_actors(6类) → get_properties(提取组件refPath) → list_properties(组件)
 *   → whitelist 匹配/标注 → 3 Tier 编排 → 结构化 JSON
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { getUeClient } from "../state.ts";
import { ATMOSPHERE_COMPONENT_GLOBS, ATMOSPHERE_WHITELIST } from "./atmosphere-whitelist.ts";

// ── 类型 ──

interface ComponentEntry {
	actor: string;
	actorRefPath: string;
	property: string;
	refPath: string;
	currentValue?: unknown;
	note?: string;
}

interface TierEntry {
	tier: number;
	label: string;
	rationale: string;
	dimensions: string[];
	components: ComponentEntry[];
}

interface MapAtmosphereResult {
	success: boolean;
	error?: string;
	tiers?: TierEntry[];
	missingComponents?: string[];
}

// ── help ──

function _extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return (content as any[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	return String(content);
}

function parseUeReturnValue(text: string): any {
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

/** find_actors 返回 [{refPath: "..."}] → 提取 actor refPath 列表 */
function extractActorRefPaths(parsed: any): string[] {
	if (Array.isArray(parsed)) {
		return parsed.map((a: any) => a?.refPath || a?.path || String(a)).filter(Boolean);
	}
	return [];
}

/** 获取组件 refPath (Actor → get_properties of component key → component refPath) */
async function resolveComponentRefPaths(
	actorRefPath: string,
	componentKeys: string[],
): Promise<{ key: string; refPath: string }[]> {
	const client = getUeClient();
	if (!client) return [];

	// 一次性读取所有组件键
	const gpName = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
	const result = await client.callTool(gpName, {
		instance: { refPath: actorRefPath },
		properties: componentKeys,
	});
	if (result.isError) return [];

	const data = parseUeReturnValue(result.text);
	if (!data || typeof data !== "object") return [];

	const paths: { key: string; refPath: string }[] = [];
	for (const key of componentKeys) {
		if (data[key]?.refPath) {
			paths.push({ key, refPath: data[key].refPath });
		}
	}
	return paths;
}

/** 匹配 whitelist → 标注属性 */
function annotateProperty(propertyName: string, componentClass: string): { dimension: string } | null {
	const match = ATMOSPHERE_WHITELIST.find((a) => a.property === propertyName && a.componentClass === componentClass);
	return match ? { dimension: match.dimension } : null;
}

// ── 主入口 ──

export const mapAtmosphereDef = {
	name: "map_atmosphere",
	label: "Map Atmosphere",
	description:
		"扫描场景中所有氛围相关组件(DirectionalLight/SkyLight/SkyAtmosphere/" +
		"ExponentialHeightFog/VolumetricCloud/PostProcessVolume)，" +
		"输出每个维度的可调参数映射表，按 Tier 排列调参顺序。",
	parameters: Type.Object({}),
	promptSnippet: "map_atmosphere: 扫描场景氛围组件，输出维度→参数映射表",
	promptGuidelines: ["调参前必须先调 map_atmosphere 了解可调参数", "按 Tier 顺序调整(Tier1→Tier2→Tier3)，不要跳级"],
};

export async function executeMapAtmosphere(): Promise<AgentToolResult> {
	const client = getUeClient();
	if (!client?.isConnected) {
		return errResult("UE MCP not connected");
	}

	const findActorsName = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";
	const listPropsName = "toolset_registry.toolsets.core.object.ObjectTools.list_properties";
	const getPropsName = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";

	const tiers: TierEntry[] = [];
	const missingComponents: string[] = [];

	for (const cfg of ATMOSPHERE_COMPONENT_GLOBS) {
		// Step 1: find_actors
		const faResult = await client.callTool(findActorsName, { glob: cfg.glob, tag: "" });
		if (faResult.isError) continue;

		const found = parseUeReturnValue(faResult.text);
		const actorRefPaths = extractActorRefPaths(found);

		if (actorRefPaths.length === 0) {
			missingComponents.push(cfg.actorClass);
			continue;
		}

		const components: ComponentEntry[] = [];

		for (const actorRefPath of actorRefPaths) {
			// Step 2: 获取组件 refPath
			// PostProcessVolume 的属性直接在 actor 上，不需要组件跳转
			let resolvedRefPath: string;
			let compClass: string;

			if (cfg.compKeys.length === 0) {
				// PostProcessVolume: 直接用 actor refPath
				resolvedRefPath = actorRefPath;
				compClass = cfg.compClass;
			} else {
				// 其他组件: get_properties 获取组件 refPath
				const compRefs = await resolveComponentRefPaths(actorRefPath, cfg.compKeys);
				if (compRefs.length === 0) {
					console.log("[map_atmosphere] compRefs EMPTY for", actorRefPath, "keys:", cfg.compKeys);
					continue;
				}
				resolvedRefPath = compRefs[0].refPath;
				compClass = cfg.compClass;
			}

			// Step 3: list_properties on the resolved path
			const compLpResult = await client.callTool(listPropsName, {
				instance: { refPath: resolvedRefPath },
			});
			if (compLpResult.isError) continue;

			const compProps = parseUeReturnValue(compLpResult.text);
			if (typeof compProps !== "object") {
				console.log(
					"[map_atmosphere] compProps not object for",
					resolvedRefPath.substring(resolvedRefPath.length - 40),
				);
				continue;
			}
			const _propNames = Object.keys(compProps);
			// Step 4: 标注属性
			for (const propName of Object.keys(compProps)) {
				const annotation = annotateProperty(propName, compClass);
				if (!annotation) continue;

				// 获取当前值
				let currentValue: unknown;
				try {
					const gvResult = await client.callTool(getPropsName, {
						instance: { refPath: resolvedRefPath },
						properties: [propName],
					});
					if (!gvResult.isError) {
						const gvData = parseUeReturnValue(gvResult.text);
						currentValue = gvData?.[propName];
					}
				} catch {
					/* skip */
				}

				// refPath: /Game/Main.Main:PersistentLevel.DirectionalLight_0 → DirectionalLight_0
				const actorShort = actorRefPath.split(":").pop() || actorRefPath;
				components.push({
					actor: actorShort,
					actorRefPath,
					property: propName,
					refPath: `${resolvedRefPath}.${propName}`,
					currentValue,
					note:
						annotation.dimension === "light_direction" && propName === "RelativeRotation"
							? "决定光源方向和它在画面中的位置，影响量化指标(亮度分布)"
							: undefined,
				});
			}
		}

		if (components.length > 0) {
			const dims = [
				...new Set(
					components
						.map((c) => {
							const a = ATMOSPHERE_WHITELIST.find(
								(w) => w.property === c.property && w.componentClass === cfg.compClass,
							);
							return a?.dimension;
						})
						.filter(Boolean),
				),
			] as string[];

			const rationales: Record<string, string> = {
				CORE_LIGHTING: "直射光和天光决定场景所有物体的受光方向和色温基调",
				ATMOSPHERE: "大气雾/体积云依赖Tier1的光方向和色温",
				POSTPROCESS: "后期处理是锦上添花，应在Tier1-2确定后从默认状态开始",
			};

			tiers.push({
				tier: cfg.tier,
				label: cfg.label,
				rationale: rationales[cfg.label] || "",
				dimensions: dims,
				components,
			});
		}
	}

	const result: MapAtmosphereResult = {
		success: true,
		tiers,
		missingComponents: missingComponents.length > 0 ? missingComponents : undefined,
	};

	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
	};
}

function _componentKeyToClass(key: string, actorClass: string): string {
	// key 如 "directionalLightComponent", "LightComponent" → class name
	const map: Record<string, Record<string, string>> = {
		DirectionalLight: {
			directionalLightComponent: "DirectionalLightComponent",
			LightComponent: "DirectionalLightComponent",
		},
		SkyLight: { skyLightComponent: "SkyLightComponent", LightComponent: "SkyLightComponent" },
		SkyAtmosphere: { skyAtmosphereComponent: "SkyAtmosphereComponent" },
		ExponentialHeightFog: { exponentialHeightFogComponent: "ExponentialHeightFogComponent" },
		VolumetricCloud: { volumetricCloudComponent: "VolumetricCloudComponent" },
		PostProcessVolume: { postProcessVolumeComponent: "PostProcessVolume" },
	};
	return map[actorClass]?.[key] || key;
}

function errResult(msg: string): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
	};
}
