/**
 * Issue 008b + 008d — 预设工具定义（save/list/delete/load）
 *
 * 008b: save_preset, list_presets, delete_preset
 * 008d: load_preset
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { Type } from "typebox";
import { getUeClient, getVisionClient, setActiveReferencePath } from "../state.ts";
import { captureViewport } from "../vision/capture.ts";
import { analyzeAndTag } from "../vision/analyzer.ts";
import { capturePresetState } from "./capture.ts";
import {
	loadAllPresets,
	savePresetEntry,
	deletePresetDir,
	presetExists,
	getPresetDir,
	loadPresetEntry,
} from "./store.ts";
import { applyPreset } from "./apply.ts";
import type { PresetEntry } from "./types.ts";

// ═══════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════

function errResult(msg: string): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
		isError: true,
	};
}

// ═══════════════════════════════════════════
// save_preset
// ═══════════════════════════════════════════

export const savePresetDef = {
	name: "save_preset",
	label: "Save Preset",
	description:
		"将当前场景的光照参数保存为预设。自动截取当前视口、生成氛围标签、快照组件属性。" +
		"同名预设存在时返回错误——需先调 delete_preset 再保存。",
	parameters: Type.Object({
		name: Type.String(),
	}),
	promptSnippet: 'save_preset("name"): 将当前场景保存为预设，下次可 load_preset 快速加载',
	promptGuidelines: [
		"仅在用户明确确认满意后调用",
		"预设名用 kebab-case（如 golden-hour-ocean）",
		"同名预设存在时会报错——先确认用户是否要覆盖，然后 delete_preset + save_preset",
	],
};

export async function executeSavePreset(params: { name: string }): Promise<AgentToolResult> {
	const ueClient = getUeClient();
	const vision = getVisionClient();

	if (!ueClient?.isConnected) return errResult("UE MCP not connected");
	if (!vision?.isConfigured) return errResult("Vision API not configured");

	// 1. 同名检测
	if (presetExists(params.name)) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						success: false,
						error: `预设 '${params.name}' 已存在。如需覆盖，请先向用户确认，然后调 delete_preset('${params.name}') 后再调 save_preset。`,
					}),
				},
			],
		};
	}

	// 2. 截图
	const capture = await captureViewport(ueClient, 1.0);
	if (!capture) return errResult("Viewport capture failed");

	// 3. Vision 标签分析
	let tagResult;
	try {
		tagResult = await analyzeAndTag(vision, capture.base64);
	} catch (e) {
		return errResult(`Vision tagging failed: ${(e as Error).message}`);
	}

	// 4. 场景快照
	const scene = await capturePresetState(ueClient);

	// 5. 组装 PresetEntry
	const entry: PresetEntry = {
		name: params.name,
		description: tagResult.description,
		tags: tagResult.tags,
		freeformTags: tagResult.freeformTags,
		screenshot: `${params.name}.png`,
		actors: scene.actors,
		postprocessReset: true,
		created: new Date().toISOString(),
	};

	// 6. 保存 + 拷贝截图
	savePresetEntry(entry);
	const presetDir = getPresetDir(params.name);
	if (!existsSync(presetDir)) {
		mkdirSync(presetDir, { recursive: true });
	}
	copyFileSync(capture.filePath, join(presetDir, `${params.name}.png`));

	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					success: true,
					name: params.name,
					tags: tagResult.tags,
					freeformTags: tagResult.freeformTags,
					actorCount: Object.keys(scene.actors).length,
					missingActors: scene.missingActors.length > 0 ? scene.missingActors : undefined,
					validation: tagResult.validation,
				}),
			},
		],
	};
}

// ═══════════════════════════════════════════
// list_presets
// ═══════════════════════════════════════════

export const listPresetsDef = {
	name: "list_presets",
	label: "List Presets",
	description: "列出所有已保存的预设（名称、标签、描述、创建时间）",
	parameters: Type.Object({}),
	promptSnippet: "list_presets(): 列出所有已保存的预设",
	promptGuidelines: ["在决定是否加载预设前，先调此工具查看可选列表"],
};

export async function executeListPresets(): Promise<AgentToolResult> {
	const presets = loadAllPresets();
	const summary = presets.map((p) => ({
		name: p.name,
		description: p.description,
		tags: p.tags,
		freeformTags: p.freeformTags,
		created: p.created,
		screenshot: p.screenshot,
	}));

	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ presets: summary, count: summary.length }),
			},
		],
	};
}

// ═══════════════════════════════════════════
// delete_preset
// ═══════════════════════════════════════════

export const deletePresetDef = {
	name: "delete_preset",
	label: "Delete Preset",
	description: "删除指定预设（包括其截图文件）。不可恢复。",
	parameters: Type.Object({
		name: Type.String(),
	}),
	promptSnippet: 'delete_preset("name"): 删除指定预设',
	promptGuidelines: ["删除前向用户确认"],
};

export async function executeDeletePreset(params: { name: string }): Promise<AgentToolResult> {
	if (!presetExists(params.name)) {
		return errResult(`预设 '${params.name}' 不存在`);
	}
	deletePresetDir(params.name);
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ deleted: true, name: params.name }),
			},
		],
	};
}

// ═══════════════════════════════════════════
// load_preset (008d)
// ═══════════════════════════════════════════

export const loadPresetDef = {
	name: "load_preset",
	label: "Load Preset",
	description:
		"加载指定预设到当前场景。批量设置 DirectionalLight/SkyLight/SkyAtmosphere/" +
		"ExponentialHeightFog/VolumetricCloud 的属性。加载后 _activeReferencePath 自动指向预设截图。" +
		"不自动触发——LLM 需要根据 before_agent_start 匹配建议主动调用。",
	parameters: Type.Object({
		name: Type.String(),
	}),
	promptSnippet: 'load_preset("name"): 批量应用预设，快速还原调参结果',
	promptGuidelines: [
		"仅在 before_agent_start 匹配建议中看到合适的预设时才调用",
		"加载后调 assess_lighting() 检验预设效果（此时 reference_path 自动指向预设截图）",
	],
};

export async function executeLoadPreset(params: { name: string }): Promise<AgentToolResult> {
	const ueClient = getUeClient();
	if (!ueClient?.isConnected) return errResult("UE MCP not connected");

	const entry = loadPresetEntry(params.name);
	if (!entry) return errResult(`预设 '${params.name}' 不存在或已损坏`);

	const result = await applyPreset(ueClient, entry);

	// 更新活跃参考路径：指向预设截图
	const presetDir = getPresetDir(params.name);
	const screenshotPath = join(presetDir, entry.screenshot);
	setActiveReferencePath(screenshotPath);

	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					loaded: true,
					name: params.name,
					referenceImage: `${entry.screenshot}（已切换为此预设的截图，assess_lighting 将自动与此截图对比）`,
					applied: result.applied,
					skipped: Object.keys(result.skipped).length > 0 ? result.skipped : undefined,
				}),
			},
		],
	};
}
