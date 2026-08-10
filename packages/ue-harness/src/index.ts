/**
 * Issue 005 — UE Harness Pi Extension 入口
 *
 * session_start → 连接 UE + Vision API + 批量注册工具 + 初始化工作流状态机
 * session_shutdown → 断开连接
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { setUeClient, setVisionClient } from "./state.ts";
import { assessLightingDef, executeAssessLighting } from "./tools/assess-lighting.ts";
import { checkDimensionDef, executeCheckDimension } from "./tools/check-dimension.ts";
import { executeMapAtmosphere, mapAtmosphereDef } from "./tools/map-atmosphere.ts";
import { UeClient } from "./ue-client/mcp-client.ts";
import { convertTool } from "./ue-client/schema-converter.ts";
import type { UeHarnessConfig } from "./ue-client/types.ts";
import { VisionClient } from "./vision/vision-client.ts";
import { checkToolCall } from "./workflow/guard-rules.ts";
import { buildBlockerSummary, buildGapSummary, buildPhaseContext } from "./workflow/injections.ts";
import { createInitialState, onAssessLighting, onCheckDimension, type PhaseState } from "./workflow/phase-machine.ts";

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

// ── UE 工具 execute() 封装 ──
function createUeToolExecutor(toolName: string) {
	return async (
		_toolCallId: string,
		params: Record<string, unknown>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<null>> => {
		if (!_ueClient?.isConnected) {
			return {
				content: [{ type: "text", text: "Error: UE MCP not connected. Please wait for session initialization." }],
				details: null,
			};
		}

		const result = await _ueClient.callToolWithRetry(toolName, params);

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
	// map_atmosphere (Issue 004 ✅)
	pi.registerTool({
		name: mapAtmosphereDef.name,
		label: mapAtmosphereDef.label,
		description: mapAtmosphereDef.description,
		parameters: mapAtmosphereDef.parameters,
		promptSnippet: mapAtmosphereDef.promptSnippet,
		promptGuidelines: mapAtmosphereDef.promptGuidelines,
		execute: () => executeMapAtmosphere(),
	});

	// assess_lighting (Issue 003 ✅)
	pi.registerTool({
		name: assessLightingDef.name,
		label: assessLightingDef.label,
		description: assessLightingDef.description,
		parameters: assessLightingDef.parameters,
		promptSnippet: assessLightingDef.promptSnippet,
		promptGuidelines: assessLightingDef.promptGuidelines,
		execute: (_id: string, params: { reference_path: string }) => executeAssessLighting(params),
	});

	// check_dimension (Issue 004 ✅)
	pi.registerTool({
		name: checkDimensionDef.name,
		label: checkDimensionDef.label,
		description: checkDimensionDef.description,
		parameters: checkDimensionDef.parameters,
		promptSnippet: checkDimensionDef.promptSnippet,
		promptGuidelines: checkDimensionDef.promptGuidelines,
		execute: (_id: string, params: { reference_path: string; dimension: string }) => executeCheckDimension(params),
	});
}

// ── 扩展入口 ──
export default function ueHarnessExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const config = getConfig();

		_ueClient = new UeClient(config);
		_visionClient = new VisionClient(config);
		setUeClient(_ueClient);
		setVisionClient(_visionClient);
		_phaseState = createInitialState();

		try {
			await _ueClient.connect();
			console.log("[ue-harness] Connected to UE MCP at", config.ueMcpUrl);
			const visionSource = process.env.VISION_API_KEY ? "env" : loadVisionAuth() ? "vision-auth.json" : "not set";
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
					console.warn(`[ue-harness] Failed to register "${tool.name}": ${(err as Error).message}`);
				}
			}

			// 注册自研工具
			registerSelfTools(pi);

			console.log(
				`[ue-harness] Tools loaded: ${registered} registered, ${excluded} excluded, ${failed} failed (total UE tools: ${allTools.length})`,
			);
		} catch (err) {
			console.error("[ue-harness] Failed to connect to UE MCP:", (err as Error).message);
		}
	});

	// ── Session Shutdown: 断开 ──
	pi.on("session_shutdown", async () => {
		if (_ueClient) {
			await _ueClient.disconnect();
			_ueClient = null;
			setUeClient(null);
			console.log("[ue-harness] Disconnected from UE MCP");
		}
		_visionClient = null;
		setVisionClient(null);
	});

	// ── Issue 005: tool_call Guard ──
	pi.on("tool_call", (event: any) => {
		const guard = checkToolCall(event.toolName, event.input, _phaseState);
		if (guard.block) {
			return { block: true, reason: guard.reason };
		}
		return undefined;
	});

	// ── Issue 007: tool_result → Phase 更新 ──
	pi.on("tool_result", (event: any) => {
		if (event.toolName === "assess_lighting") {
			try {
				const text = event.content?.[0]?.text || "";
				const data = JSON.parse(text);
				onAssessLighting(
					_phaseState,
					data.gaps,
					data.artificiality?.detected || false,
					data.blocking_dimensions,
					data.quantitative?.histogramCorrelation,
				);
				console.log(
					"[ue-harness] Phase:",
					_phaseState.phase,
					"Tier:",
					_phaseState.tier,
					"Blockers:",
					_phaseState.blockingDimensions.join(",") || "none",
					"Assess:",
					_phaseState.assessCount,
					"Unchanged:",
					_phaseState.unchangedRounds,
				);
			} catch {}
		} else if (event.toolName === "check_dimension") {
			try {
				const text = event.content?.[0]?.text || "";
				const data = JSON.parse(text);
				onCheckDimension(_phaseState, data.dimension || "unknown", data.verdict || "unknown");
			} catch {
				onCheckDimension(_phaseState, "unknown", "unknown");
			}
		}
	});

	// ── Issue 007: before_agent_start 注入 ──
	pi.on("before_agent_start", (event: any) => {
		const phaseCtx = buildPhaseContext(_phaseState);
		const gapSummary = buildGapSummary(_phaseState);
		const blockerSummary = buildBlockerSummary(_phaseState);
		const appendix = phaseCtx + gapSummary + blockerSummary;
		if (appendix) {
			return { systemPrompt: `${event.systemPrompt || ""}\n${appendix}` };
		}
		return undefined;
	});

	console.log("[ue-harness] Extension loaded (Issue 007 — Gap Quality + Flow Control)");
}
