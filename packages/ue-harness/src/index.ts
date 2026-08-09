/**
 * Issue 003 — UE Harness Pi Extension 入口
 *
 * session_start → 连接 UE + Vision API + 批量注册工具
 * session_shutdown → 断开连接
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Type } from "typebox";
import { setUeClient, setVisionClient } from "./state.ts";
import { assessLightingDef, executeAssessLighting } from "./tools/assess-lighting.ts";
import { UeClient } from "./ue-client/mcp-client.ts";
import { convertTool } from "./ue-client/schema-converter.ts";
import type { UeHarnessConfig } from "./ue-client/types.ts";
import { VisionClient } from "./vision/vision-client.ts";

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

// ── 自研工具占位 ──
async function stubResult(name: string): Promise<AgentToolResult<null>> {
	return {
		content: [{ type: "text", text: `[${name}] Not yet implemented.` }],
		details: null,
	};
}

function registerSelfTools(pi: ExtensionAPI): void {
	// map_atmosphere (Issue 004)
	pi.registerTool({
		name: "map_atmosphere",
		label: "Map Atmosphere",
		description: "扫描场景中 5 类氛围组件，输出维度→UE属性映射表，按 Tier 排列调参顺序。",
		parameters: Type.Object({}),
		execute: () => stubResult("map_atmosphere"),
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

	// check_dimension (Issue 004)
	pi.registerTool({
		name: "check_dimension",
		label: "Check Dimension",
		description: "单维度方向性验证：当前截图在指定维度上是 closer/similar/further 于参考图。",
		parameters: Type.Object({
			reference_path: Type.String(),
			dimension: Type.String(),
		}),
		execute: () => stubResult("check_dimension"),
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

	console.log("[ue-harness] Extension loaded (Issue 003 — Vision Pipeline)");
}
