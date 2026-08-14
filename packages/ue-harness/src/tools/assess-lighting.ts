/**
 * Issue 009b — assess_lighting 串行化重写
 *
 * 新架构: Vision 从"并行竞争者"变为"串行决策者"。
 * Stage 1 (并行): computeMetrics + analyzeAndTag
 * Stage 2 (串行): Vision 综合定量数据+双图 → 结构化分析
 *
 * SETUP 阶段自动重置 PostProcess 到默认值，消除 artificiality catch-22。
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readFileSync } from "fs";
import { Type } from "typebox";
import { getUeClient, getVisionClient, getPhaseState } from "../state.ts";
import { captureViewport } from "../vision/capture.ts";
import { computeMetrics, type QuantitativeReport } from "../vision/metrics.ts";
import { ASSESS_LIGHTING_PROMPT } from "../vision/prompts.ts";
import { analyzeAndTag, type TagResult } from "../vision/analyzer.ts";
import type { UeToolCaller } from "../ue-client/types.ts";
import { buildTierListDescription, getTierDef, TIER_ORDER } from "../workflow/tiers.ts";

// ── Types ──

export interface AnalysisEntry {
	/** Vision 命名的差异名称 (kebab-case, 如 "brightness", "shadow_warmth") */
	aspect: string;
	/** 此差异是否需要继续调参 */
	status: "close_enough" | "needs_adjustment";
	/** 关联的 Tier (1/2/3), 由 Vision 在 prompt 指令下标记 */
	tier: number;
	/** 诊断 + 具体调参建议 (1-2 句中文) */
	suggestion: string;
}

export interface AssessLightingResult {
	success: boolean;
	error?: string;

	reference: { path: string; fileSize: number };
	current: { filePath: string; fileSize: number };

	/** 代码计算的完整定量报告 */
	quantitative: QuantitativeReport;

	/** Vision 的结构化分析 */
	analysis: AnalysisEntry[];

	/** Vision 的总体评价 (1-2 句) */
	overall: string;

	/** Issue 008c: 参考图的标签 (与 metrics 并行计算) */
	tagResult?: TagResult;

	meta: {
		visionTokens: number;
		captureMs: number;
		quantitativeMs: number;
		visionMs: number;
	};
}

// ── __CURRENT_TIER_INFO__ 生成 ──

function buildCurrentTierInfo(tier: number, tierRoundCount: number): string {
	const def = getTierDef(tier);
	if (!def) return "";

	const head = `当前调参阶段: Tier ${tier} (第 ${tierRoundCount} 轮)`;
	const tunable = `可调参数: ${def.components} (${def.properties})`;
	const higher = TIER_ORDER.filter((t) => t.id > tier).map((t) => t.label);
	const untunable = higher.length > 0 ? `不可调: ${higher.join("、")} (这些属于更高 Tier)` : "";

	return [head, tunable, untunable].filter(Boolean).join("\n");
}

// ── SETUP PostProcess 重置 ──

function parseUeReturnValue(text: string): unknown {
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

function extractActorRefPaths(parsed: unknown): string[] {
	if (Array.isArray(parsed)) {
		return (parsed as Array<Record<string, unknown>>)
			.map((a) => (typeof a?.refPath === "string" ? a.refPath : typeof a?.path === "string" ? a.path : null))
			.filter((p): p is string => p !== null);
	}
	return [];
}

/**
 * SETUP 阶段: 将场景中所有 PostProcessVolume 的 color grading 参数重置为引擎默认值。
 *
 * PPV 的 color grading 参数嵌套在 Settings 子结构 (FPostProcessSettings) 中，
 * 不能直接在 actor 上 set 单个属性。必须:
 *   1. get_properties 读取完整 settings struct
 *   2. 修改目标字段 + 设置对应的 bOverride_* 标志
 *   3. set_properties 以 values (JSON字符串) 写回 {"settings": modifiedSettings}
 *
 * 参考: E:/Programs/UE_Project_58/MCP/Test/ppv_test2.py
 *       E:/Programs/UE_Project_58/MCP/Test/test_ppv_direct.py
 */
async function resetPostProcessToDefaults(caller: UeToolCaller): Promise<void> {
	const GET_PROPS = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
	const SET_PROPS = "toolset_registry.toolsets.core.object.ObjectTools.set_properties";
	const FIND_ACTORS = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";

	// Step 1: 查找所有 PostProcessVolume actor
	const findResult = await caller.callTool(FIND_ACTORS, { glob: "*PostProcessVolume*", tag: "" });
	if (findResult.isError) {
		console.log("[ue-harness] resetPostProcess: find_actors failed, skipping");
		return;
	}

	const parsed = parseUeReturnValue(findResult.text);
	const actorRefPaths = extractActorRefPaths(parsed);
	if (actorRefPaths.length === 0) {
		console.log("[ue-harness] resetPostProcess: no PostProcessVolume found, skipping");
		return;
	}

	console.log(`[ue-harness] resetPostProcess: resetting ${actorRefPaths.length} PostProcessVolume(s)`);

	for (const refPath of actorRefPaths) {
		// Step 2: 读取完整的 settings struct
		const getResult = await caller.callTool(GET_PROPS, {
			instance: { refPath },
			properties: ["settings"],
		});
		if (getResult.isError) {
			console.log(`[ue-harness] resetPostProcess: get_properties failed for ${refPath}`);
			continue;
		}

		let raw = parseUeReturnValue(getResult.text);
		// 解包多层 JSON
		if (typeof raw === "string") {
			try { raw = JSON.parse(raw); } catch { /* keep as-is */ }
		}
		const settingsObj = (raw as Record<string, unknown>)?.settings as Record<string, unknown> | undefined;
		if (!settingsObj || typeof settingsObj !== "object") {
			console.log(`[ue-harness] resetPostProcess: could not extract settings from ${refPath}`);
			continue;
		}

		// Step 3: 修改 color grading 参数 + bOverride 标志
		// 实机验证 (2026-08-14): 值字段为小写 camelCase (whiteTemp, colorSaturation...),
		// FVector4 为小写 {x,y,z,w}; bOverride 标志保持 PascalCase (bOverride_WhiteTemp)。
		// 旧写法 (WhiteTemp / {X,Y,Z,W}) 写入被 UE 静默忽略 (不报错、不生效)。
		const modified = { ...settingsObj };
		// 色温
		modified["bOverride_WhiteTemp"] = true;
		modified["whiteTemp"] = 6500;
		// 饱和度 (FVector4)
		modified["bOverride_ColorSaturation"] = true;
		modified["colorSaturation"] = { x: 1, y: 1, z: 1, w: 1 };
		// 对比度
		modified["bOverride_ColorContrast"] = true;
		modified["colorContrast"] = { x: 1, y: 1, z: 1, w: 1 };
		// 伽马
		modified["bOverride_ColorGamma"] = true;
		modified["colorGamma"] = { x: 1, y: 1, z: 1, w: 1 };
		// 胶片色调映射
		modified["bOverride_FilmSlope"] = true;
		modified["filmSlope"] = 0.88;
		modified["bOverride_FilmToe"] = true;
		modified["filmToe"] = 0.55;
		// 色散
		modified["bOverride_SceneFringeIntensity"] = true;
		modified["sceneFringeIntensity"] = 0;
		// 调色混合
		modified["bOverride_ColorGradingIntensity"] = true;
		modified["colorGradingIntensity"] = 1;

		// Step 4: 以 values JSON 字符串写回 (非 properties object!)
		const setResult = await caller.callTool(SET_PROPS, {
			instance: { refPath },
			values: JSON.stringify({ settings: modified }),
		});

		if (setResult.isError) {
			console.log(
				`[ue-harness] resetPostProcess: set_properties failed for ${refPath}: ${setResult.text.substring(0, 80)}`,
			);
		} else {
			console.log(`[ue-harness] resetPostProcess: ${refPath} -> defaults OK`);
		}
	}
}

// ── 主入口: ToolDefinition + execute ──

export const assessLightingDef = {
	name: "assess_lighting",
	label: "Assess Lighting",
	description:
		"对比参考图与当前场景截图，Vision 综合 12 项定量指标给出结构化诊断。" +
		"每个 aspect 标记 close_enough / needs_adjustment 及根因 tier，含具体调参建议。" +
		"SETUP 阶段自动重置 PostProcess 到默认值。",
	parameters: Type.Object({
		reference_path: Type.String(),
	}),
	promptSnippet: "assess_lighting: Vision 综合定量数据+双图对比，输出结构化诊断报告",
	promptGuidelines: [
		"每次调参后用 assess_lighting 获取全维度状态",
		"Vision 的 analysis 中 needs_adjustment 项 = 仍需调参的 aspect",
		"所有 aspect close_enough → 自动进入下一 Tier",
		"首次调用时 PostProcess 会自动重置到默认值",
	],
};

export async function executeAssessLighting(
	params: { reference_path: string },
): Promise<AgentToolResult<null>> {
	const ueClient = getUeClient();
	const vision = getVisionClient();
	const state = getPhaseState();

	if (!ueClient?.isConnected) return errResult("UE MCP not connected");
	if (!vision?.isConfigured) return errResult("VISION_API_KEY not configured");

	const refPath = params.reference_path;
	const meta = { visionTokens: 0, captureMs: 0, quantitativeMs: 0, visionMs: 0 };

	// ═══════════════════════════════════
	// SETUP: 首次 assess 前重置 PostProcess 到默认值
	// ═══════════════════════════════════
	if (state && state.phase === "SETUP") {
		await resetPostProcessToDefaults(ueClient);
	}

	// ── 加载参考图 ──
	let refBuffer: Buffer;
	try {
		refBuffer = readFileSync(refPath);
	} catch {
		return errResult(`Reference image not found: ${refPath}`);
	}
	const refBase64 = refBuffer.toString("base64");

	// ── 捕获当前截图 ──
	const capture = await captureViewport(ueClient, 1.0);
	if (!capture) return errResult("Viewport capture failed");
	meta.captureMs = capture.elapsedMs;

	// ═══════════════════════════════════
	// Stage 1 (并行): 定量指标 + 标签分析
	// ═══════════════════════════════════
	const qStart = Date.now();
	const [quantitative, refTagResult] = await Promise.all([
		computeMetrics(refBuffer, Buffer.from(capture.base64, "base64")),
		analyzeAndTag(vision, refBase64),
	]);
	meta.quantitativeMs = Date.now() - qStart;

	// ═══════════════════════════════════
	// Stage 2 (串行): Vision 氛围分析
	// ═══════════════════════════════════
	const vStart = Date.now();
	const quantReportStr = JSON.stringify(quantitative);
	const tierInfo = state
		? buildCurrentTierInfo(state.tier, state.tierRoundCount)
		: buildCurrentTierInfo(1, 0);
	const prompt = ASSESS_LIGHTING_PROMPT
		.replace("__QUANTITATIVE_REPORT__", quantReportStr)
		.replace("__CURRENT_TIER_INFO__", tierInfo)
		.replace("__TIER_LIST__", buildTierListDescription());

	const visionRaw = await vision.sendAndParse<{
		analysis: AnalysisEntry[];
		overall: string;
	}>({
		prompt,
		images: [
			{ base64: refBase64 },
			{ base64: capture.base64 },
		],
		maxTokens: 3000,
	});
	meta.visionMs = Date.now() - vStart;
	meta.visionTokens = 1 * 3000; // 1 Vision call @ 3000 tokens

	// ── 组装结果 ──
	const result: AssessLightingResult = {
		success: true,
		reference: { path: refPath, fileSize: refBuffer.length },
		current: { filePath: capture.filePath, fileSize: capture.fileSize },
		quantitative,
		analysis: visionRaw.analysis || [],
		overall: visionRaw.overall || "",
		tagResult: refTagResult,
		meta,
	};

	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: null,
	};
}

function errResult(msg: string): AgentToolResult<null> {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
		details: null,
	};
}
