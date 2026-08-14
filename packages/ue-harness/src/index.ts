/**
 * Issue 009 — UE Harness Pi Extension 入口
 *
 * session_start → 连接 UE + Vision API + 批量注册工具 + 初始化工作流状态机
 * session_shutdown → 断开连接
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { setPhaseState, setUeClient, setVisionClient } from "./state.ts";
import { assessLightingDef, executeAssessLighting, type AssessLightingResult } from "./tools/assess-lighting.ts";
import { executeMapAtmosphere, mapAtmosphereDef } from "./tools/map-atmosphere.ts";
import {
	savePresetDef,
	executeSavePreset,
	listPresetsDef,
	executeListPresets,
	deletePresetDef,
	executeDeletePreset,
	loadPresetDef,
	executeLoadPreset,
} from "./presets/tools.ts";
import { UeClient } from "./ue-client/mcp-client.ts";
import { convertTool } from "./ue-client/schema-converter.ts";
import type { UeHarnessConfig } from "./ue-client/types.ts";

import { VisionClient } from "./vision/vision-client.ts";
import { loadAllPresets } from "./presets/store.ts";
import { matchPresets } from "./presets/match.ts";
import { EmbeddingService } from "./presets/embedding.ts";
import { BM25Index } from "./presets/bm25.ts";
import { checkToolCall } from "./workflow/guard-rules.ts";
import { buildInjectionAppendix, buildPresetSuggestion } from "./workflow/injections.ts";
import {
	createInitialState,
	onAssessLighting,
	recordWrite,
	type PhaseState,
	type QuantitativeSnapshot,
	type WriteChannel,
} from "./workflow/phase-machine.ts";
import { extractRefPath, extractWriteTarget } from "./workflow/tiers.ts";
import { applyRollback } from "./workflow/rollback.ts";

// ── Vision auth 文件 ──

/** ~/.pi/agent/vision-auth.json 的内容格式 */
interface VisionAuthFile {
	apiKey: string;
	baseUrl?: string;
	modelId?: string;
}

function loadVisionAuth(): VisionAuthFile | null {
	const visionAuthPath = join(homedir(), ".pi", "agent", "vision-auth.json");
	try {
		if (existsSync(visionAuthPath)) {
			return JSON.parse(readFileSync(visionAuthPath, "utf-8")) as VisionAuthFile;
		}
	} catch {
		// ignore parse errors
	}
	return null;
}

// ── 扩展级单例 ──
let _ueClient: UeClient | null = null;
let _visionClient: VisionClient | null = null;
let _phaseState: PhaseState = createInitialState();
let _embeddingService: EmbeddingService | null = null;
let _bm25Index: BM25Index | null = null;

function getConfig(): UeHarnessConfig {
	const visionAuth = loadVisionAuth();

	// 优先级: 环境变量 > vision-auth.json > 默认值
	const visionApiKey = process.env.VISION_API_KEY || visionAuth?.apiKey;
	const visionApiBaseUrl = process.env.VISION_API_BASE_URL || visionAuth?.baseUrl;
	const visionModelId = process.env.VISION_MODEL_ID || visionAuth?.modelId;

	return {
		ueMcpUrl: process.env.UE_MCP_URL || "http://localhost:8000/mcp",
		visionApiKey,
		visionApiBaseUrl,
		visionModelId,
		visionMaxTokens: process.env.VISION_MAX_TOKENS ? parseInt(process.env.VISION_MAX_TOKENS, 10) : 3000,
		ueMcpTimeoutMs: process.env.UE_MCP_TIMEOUT_MS ? parseInt(process.env.UE_MCP_TIMEOUT_MS, 10) : 60000,
		ueMcpReconnectMax: process.env.UE_MCP_RECONNECT_MAX ? parseInt(process.env.UE_MCP_RECONNECT_MAX, 10) : 3,
	};
}

// ── Issue 012: 写前读 + 回滚 (停滞收敛) ──

const SET_PROPS_KEYWORD = "set_properties";
const GET_PROPS_TOOL = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
const SET_TRANSFORM_KEYWORD = "set_actor_transform";
const GET_TRANSFORM_TOOL = "toolset_registry.toolsets.core.actor.ActorTools.get_actor_transform";

interface PreWriteEntry {
	refPath: string;
	prop: string;
	from: unknown;
	to: unknown;
	channel: WriteChannel;
}

/** 解析 UE 返回的 returnValue 包裹 (与 map-atmosphere.ts / assess-lighting.ts 相同逻辑) */
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

/** 写前读当前值 (get_properties)，返回成功读取的 prop → 旧值 */
async function readCurrentValues(refPath: string, propNames: string[]): Promise<Record<string, unknown>> {
	const result: Record<string, unknown> = {};
	if (!_ueClient?.isConnected || propNames.length === 0) return result;
	try {
		const r = await _ueClient.callToolWithRetry(GET_PROPS_TOOL, {
			instance: { refPath },
			properties: propNames,
		});
		if (!r.isError) {
			const data = parseUeReturnValue(r.text);
			if (data && typeof data === "object") {
				for (const p of propNames) {
					if (p in (data as Record<string, unknown>)) {
						result[p] = (data as Record<string, unknown>)[p];
					}
				}
			}
		}
	} catch { /* ignore */ }
	return result;
}

/** 读当前 actor transform (get_actor_transform) */
async function readCurrentTransform(refPath: string): Promise<unknown> {
	if (!_ueClient?.isConnected) return undefined;
	try {
		const r = await _ueClient.callToolWithRetry(GET_TRANSFORM_TOOL, { actor: { refPath } });
		if (r.isError) return undefined;
		return parseUeReturnValue(r.text);
	} catch {
		return undefined;
	}
}

/** set_properties 写前读：返回可记录的 from/to 条目 (读取失败的 prop 跳过) */
async function capturePreWrite(params: Record<string, unknown>): Promise<PreWriteEntry[] | null> {
	if (!_ueClient?.isConnected || !_phaseState) return null;
	const target = extractWriteTarget(params);
	if (!target) return null;
	const propNames = Object.keys(target.props);
	if (propNames.length === 0) return null;

	// 通道判定: properties object → properties; values JSON 字符串 → values (PPV settings struct)
	const channel: WriteChannel =
		params.properties !== undefined && typeof params.properties === "object"
			? "properties"
			: "values";

	const fromValues = await readCurrentValues(target.refPath, propNames);

	const entries: PreWriteEntry[] = [];
	for (const [prop, to] of Object.entries(target.props)) {
		if (prop in fromValues) {
			entries.push({ refPath: target.refPath, prop, from: fromValues[prop], to, channel });
		}
	}
	return entries.length > 0 ? entries : null;
}

/** set_actor_transform 写前读：读当前 transform，记录 transform 的 from/to */
async function captureTransformPreWrite(params: Record<string, unknown>): Promise<PreWriteEntry[] | null> {
	if (!_ueClient?.isConnected || !_phaseState) return null;
	const refPath = extractRefPath(params);
	if (!refPath) return null;
	const to = (params as Record<string, unknown>).transform;
	if (to === undefined) return null;
	const from = await readCurrentTransform(refPath);
	if (from === undefined) return null;
	return [{ refPath, prop: "transform", from, to, channel: "transform" }];
}

/** Issue 012: footer 状态栏显示的 tier 文本 */
function buildTierStatus(state: PhaseState): string {
	switch (state.phase) {
		case "SETUP":
			return "SETUP";
		case "TUNING":
			return `Tier ${state.tier} · 第 ${state.tierRoundCount} 轮`;
		case "POSTPROCESS_SETUP":
			return "POSTPROCESS_SETUP";
		case "FINAL":
			return "FINAL VERIFICATION";
		case "DONE":
			return "DONE";
		default:
			return "";
	}
}

/** Issue 012: 更新 TUI footer 状态 + 停滞持久化提示面板 (强制推进时) */
function updateTierUI(ctx: ExtensionContext, state: PhaseState): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("ue-harness-tier", buildTierStatus(state));
	if (state.lastStall?.stalled) {
		ctx.ui.setWidget("ue-harness-stall", [`⚠️ ${state.lastStall.reason}`], { placement: "aboveEditor" });
	}
}

// ── UE 工具 execute() 封装 ──
function createUeToolExecutor(toolName: string) {
	return async (
		_toolCallId: string,
		params: Record<string, unknown>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<null>> => {
		if (!_ueClient?.isConnected) {
			return {
				content: [
					{
						type: "text",
						text: "Error: UE MCP not connected. Please wait for session initialization.",
					},
				],
				details: null,
			};
		}

		// Issue 012: 写前读 (记录 from 值, 供停滞回滚) — set_properties 或 set_actor_transform
		const journal = toolName.includes(SET_PROPS_KEYWORD)
			? await capturePreWrite(params)
			: toolName.includes(SET_TRANSFORM_KEYWORD)
				? await captureTransformPreWrite(params)
				: null;

		const result = await _ueClient.callToolWithRetry(toolName, params);

		// Issue 012: 写成功后记录变迁日志
		if (journal && !result.isError) {
			for (const e of journal) {
				recordWrite(_phaseState, e.refPath, e.prop, e.from, e.to, e.channel);
			}
		}

		if (result.isError) {
			const tag = result.errorType ? `[${result.errorType}] ` : "";
			return {
				content: [{ type: "text", text: `${tag}${result.text}` }],
				details: null,
			};
		}

		return {
			content: [{ type: "text", text: result.text }],
			details: null,
		};
	};
}

function registerSelfTools(pi: ExtensionAPI): void {
	// map_atmosphere (Issue 004)
	pi.registerTool({
		name: mapAtmosphereDef.name,
		label: mapAtmosphereDef.label,
		description: mapAtmosphereDef.description,
		parameters: mapAtmosphereDef.parameters,
		promptSnippet: mapAtmosphereDef.promptSnippet,
		promptGuidelines: mapAtmosphereDef.promptGuidelines,
		execute: () => executeMapAtmosphere(),
	});

	// assess_lighting (Issue 009 — serial architecture)
	pi.registerTool({
		name: assessLightingDef.name,
		label: assessLightingDef.label,
		description: assessLightingDef.description,
		parameters: assessLightingDef.parameters,
		promptSnippet: assessLightingDef.promptSnippet,
		promptGuidelines: assessLightingDef.promptGuidelines,
		execute: (_id: string, params: { reference_path: string }) => executeAssessLighting(params),
	});

	// ── Issue 008b: 预设工具 ──
	pi.registerTool({
		name: savePresetDef.name,
		label: savePresetDef.label,
		description: savePresetDef.description,
		parameters: savePresetDef.parameters,
		promptSnippet: savePresetDef.promptSnippet,
		promptGuidelines: savePresetDef.promptGuidelines,
		execute: (_id: string, params: { name: string }) => executeSavePreset(params),
	});

	pi.registerTool({
		name: listPresetsDef.name,
		label: listPresetsDef.label,
		description: listPresetsDef.description,
		parameters: listPresetsDef.parameters,
		promptSnippet: listPresetsDef.promptSnippet,
		promptGuidelines: listPresetsDef.promptGuidelines,
		execute: () => executeListPresets(),
	});

	pi.registerTool({
		name: deletePresetDef.name,
		label: deletePresetDef.label,
		description: deletePresetDef.description,
		parameters: deletePresetDef.parameters,
		promptSnippet: deletePresetDef.promptSnippet,
		promptGuidelines: deletePresetDef.promptGuidelines,
		execute: (_id: string, params: { name: string }) => executeDeletePreset(params),
	});

	pi.registerTool({
		name: loadPresetDef.name,
		label: loadPresetDef.label,
		description: loadPresetDef.description,
		parameters: loadPresetDef.parameters,
		promptSnippet: loadPresetDef.promptSnippet,
		promptGuidelines: loadPresetDef.promptGuidelines,
		execute: (_id: string, params: { name: string }) => executeLoadPreset(params),
	});
}

// ── Issue 011: 混合检索初始化 ──

/**
 * session_start 时初始化 embedding + bm25 服务，并同步 preset 索引。
 * 失败不阻断（embedding 模型缺失时退化为纯 Jaccard 匹配）。
 */
async function initializePresetRetrieval(): Promise<void> {
	// BM25 索引（纯 JS，无依赖）
	_bm25Index = new BM25Index();

	// Embedding 服务（ONNX 本地推理，模型缺失则跳过）
	_embeddingService = new EmbeddingService();
	try {
		await _embeddingService.initialize();
	} catch (err) {
		console.warn(
			"[ue-harness] Embedding service unavailable, falling back to Jaccard+BM25:",
			(err as Error).message,
		);
		_embeddingService = null;
	}

	// 同步 preset 索引（embedding 向量 + bm25 倒排）
	const presets = loadAllPresets();
	_bm25Index.buildIndex(presets);
	if (_embeddingService) {
		await _embeddingService.syncPresets(presets);
	}
}

// ── AssessLightingResult → QuantitativeSnapshot 转换 ──

function extractQuantSnapshot(assessCount: number, result: AssessLightingResult): QuantitativeSnapshot {
	const q = result.quantitative;
	// Sky/ground luminance ratio: approximate from regional section
	const skyLum = q.regional.sky.luminance;
	const groundLum = q.regional.ground.luminance;
	const totalLum = skyLum.cur + q.regional.horizon.luminance.cur + groundLum.cur;

	return {
		assessIndex: assessCount,
		luminanceDeltaPct: q.luminance.deltaPct,
		deltaE_mean: q.deltaE.mean,
		deltaE_p90: q.deltaE.p90,
		chroma_diff: q.chroma.diff,
		skyLuminanceRatio: totalLum > 0 ? skyLum.cur / totalLum : 0,
		groundLuminanceRatio: totalLum > 0 ? groundLum.cur / totalLum : 0,
		histogramCorrelation: q.histogramCorrelation,
	};
}

// ── 扩展入口 ──
export default function ueHarnessExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const config = getConfig();

		_ueClient = new UeClient(config);
		_visionClient = new VisionClient(config);
		setUeClient(_ueClient);
		setVisionClient(_visionClient);
		_phaseState = createInitialState();
		setPhaseState(_phaseState);
		updateTierUI(ctx, _phaseState);

		try {
			await _ueClient.connect();
			console.log("[ue-harness] Connected to UE MCP at", config.ueMcpUrl);
			const visionSource = process.env.VISION_API_KEY
				? "env"
				: loadVisionAuth()
					? "vision-auth.json"
					: "not set";
			console.log(
				"[ue-harness] Vision API:",
				_visionClient.isConfigured
					? `configured (via ${visionSource})`
					: "NOT CONFIGURED — create ~/.pi/agent/vision-auth.json",
			);

			// 获取全部工具并转换注册
			const allTools = await _ueClient.listAllTools();
			let registered = 0;
			let excluded = 0;
			let failed = 0;

			for (const tool of allTools) {
				const converted = convertTool(tool);
				if (!converted) {
					excluded++;
					continue;
				}

				try {
					pi.registerTool({
						name: converted.registration.name,
						label: converted.registration.label,
						description: converted.registration.description,
						parameters: converted.registration.parameters,
						promptSnippet: converted.registration.promptSnippet,
						execute: createUeToolExecutor(converted.registration.ueName),
					});
					registered++;
				} catch (err) {
					failed++;
					console.warn(
						`[ue-harness] Failed to register "${tool.name}": ${(err as Error).message}`,
					);
				}
			}

			// 注册自研工具 (assess_lighting, map_atmosphere, preset tools)
			registerSelfTools(pi);

			console.log(
				`[ue-harness] Tools loaded: ${registered} registered, ${excluded} excluded, ${failed} failed (total UE tools: ${allTools.length})`,
			);

			// ── Issue 011: 初始化混合检索服务（embedding + bm25）──
			await initializePresetRetrieval();
		} catch (err) {
			console.error("[ue-harness] Failed to connect to UE MCP:", (err as Error).message);
		}
	});

	// ── Session Shutdown: 断开 ──
	pi.on("session_shutdown", async (_event, ctx) => {
		if (_ueClient) {
			await _ueClient.disconnect();
			_ueClient = null;
			setUeClient(null);
			console.log("[ue-harness] Disconnected from UE MCP");
		}
		_visionClient = null;
		setVisionClient(null);
		_phaseState = createInitialState();
		setPhaseState(null);
		_embeddingService = null;
		_bm25Index = null;

		if (ctx?.hasUI) {
			ctx.ui.setStatus("ue-harness-tier", undefined);
			ctx.ui.setWidget("ue-harness-stall", undefined);
		}
	});

	// ── Issue 005: tool_call Guard ──
	pi.on("tool_call", (event: any) => {
		const guard = checkToolCall(event.toolName, event.input, _phaseState);
		if (guard.block) {
			return { block: true, reason: guard.reason };
		}
		return undefined;
	});

	// ── Issue 009: tool_result → Phase 更新 ──
	pi.on("tool_result", async (event: any, ctx) => {
		if (event.toolName !== "assess_lighting") return undefined;

		try {
			const text = event.content?.[0]?.text || "";
			const data = JSON.parse(text) as AssessLightingResult;
			if (!data.success) return undefined;

			const snapshot = extractQuantSnapshot(_phaseState.assessCount + 1, data);
			onAssessLighting(
				_phaseState,
				data.analysis,
				data.overall,
				data.quantitative?.histogramCorrelation,
				snapshot,
			);

			console.log(
				"[ue-harness] Phase:",
				_phaseState.phase,
				"Tier:",
				_phaseState.tier,
				"Round:",
				_phaseState.tierRoundCount,
				"CE/NA:",
				`${data.analysis.filter((a) => a.status === "close_enough").length}/` +
					`${data.analysis.filter((a) => a.status === "needs_adjustment").length}`,
				"Assess:",
				_phaseState.assessCount,
			);

			updateTierUI(ctx, _phaseState);

			const extraContent: Array<{ type: "text"; text: string }> = [];

			// Issue 012: 停滞回滚 (onAssessLighting 可能设置了 pendingRollback)
			if (_phaseState.pendingRollback && _phaseState.pendingRollback.length > 0) {
				const rb = _phaseState.pendingRollback;
				_phaseState.pendingRollback = null;
				const note = _ueClient?.isConnected ? await applyRollback(_ueClient, rb) : null;
				if (note) extraContent.push({ type: "text", text: note });
			}

			// Issue 008c: 存储 TagResult
			if (data.tagResult) {
				_phaseState.lastTagResult = data.tagResult;
			}

			// Issue 011: 第一次 assess 后，混合检索匹配 preset，追加建议到 tool result
			if (data.tagResult && _phaseState.assessCount === 1) {
				const presets = loadAllPresets();
				if (presets.length > 0) {
					const matches = await matchPresets(
						{ tags: data.tagResult.tags, description: data.tagResult.description },
						presets,
						{ embedding: _embeddingService, bm25: _bm25Index },
						{ topN: 5 },
					);
					if (matches.length > 0) {
						const suggestion = buildPresetSuggestion(matches);
						console.log(
							"[ue-harness] Preset matches:",
							matches.map((m) => `${m.name}(${m.score})`).join(", "),
						);
						extraContent.push({ type: "text", text: suggestion });
					}
				}
			}

			if (extraContent.length > 0) {
				return { content: [...event.content, ...extraContent] };
			}
			return undefined;
		} catch {
			/* ignore parse errors */
			return undefined;
		}
	});

	// ── Issue 009: before_agent_start 注入 ──
	pi.on("before_agent_start", (event: any) => {
		const appendix = buildInjectionAppendix(_phaseState);
		if (appendix) {
			return { systemPrompt: `${event.systemPrompt || ""}\n${appendix}` };
		}
		return undefined;
	});

	console.log("[ue-harness] Extension loaded");
}
