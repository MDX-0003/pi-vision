/**
 * Issue 002 — UE Harness Pi Extension 入口
 *
 * session_start → 连接 UE + 加载工具集 + 批量注册
 * session_shutdown → 断开连接
 *
 * 自研工具占位: map_atmosphere / assess_lighting / check_dimension
 * (Issue 003-004 实现)
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { UeClient } from "./ue-client/mcp-client.ts";
import { convertTool } from "./ue-client/schema-converter.ts";
import type { UeHarnessConfig } from "./ue-client/types.ts";

// ── 扩展级单例 ──
let _ueClient: UeClient | null = null;

function getConfig(): UeHarnessConfig {
	return {
		ueMcpUrl: process.env.UE_MCP_URL || "http://localhost:8000/mcp",
		visionApiKey: process.env.VISION_API_KEY,
		visionApiBaseUrl: process.env.VISION_API_BASE_URL,
		visionModelId: process.env.VISION_MODEL_ID,
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
		content: [{ type: "text", text: `[${name}] Not yet implemented. (Issue 003-004)` }],
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

	// assess_lighting (Issue 003)
	pi.registerTool({
		name: "assess_lighting",
		label: "Assess Lighting",
		description: "对比参考图与当前截图，输出每维度 gap 报告（量化指标 + Vision 主观评估）。",
		parameters: Type.Object({
			reference_path: Type.String(),
		}),
		execute: () => stubResult("assess_lighting"),
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
	// ── Session Start: 连接 UE + 批量注册工具 ──
	pi.on("session_start", async () => {
		const config = getConfig();

		_ueClient = new UeClient(config);

		try {
			await _ueClient.connect();
			console.log("[ue-harness] Connected to UE MCP at", config.ueMcpUrl);

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
			console.log("[ue-harness] Disconnected from UE MCP");
		}
	});

	console.log("[ue-harness] Extension loaded (Issue 002 — MCP Bridge)");
}
