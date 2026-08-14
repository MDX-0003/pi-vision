/**
 * Issue 002 — UE MCP Client 封装
 *
 * 基于 Issue 001 Spike 验证的稳定模式封装。
 *  · StreamableHTTP 连接 (SDK 内部处理 SSE + session)
 *  · 工具集延迟加载 (list_toolsets → load_toolset → re-list)
 *  · 错误分类: timeout / server_error / tool_not_found / validation_error
 *  · 自动重连 (指数退避)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpCallResult, UeHarnessConfig, UeToolDefinition,UeToolCaller } from "./types.ts";

// ── 工具集加载 ──

/** list_toolsets 返回的纯文本格式: "- ToolsetRegistry.Name: Description\n- ..."
 *  用正则提取工具集全限定名 */
function parseToolsetNames(tsText: string): string[] {
	return [...tsText.matchAll(/^\s*-\s*(\S+):/gm)].map((m) => m[1]);
}

// ── 内容提取 ──

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: Record<string, unknown>) => c.type === "text")
			.map((c: Record<string, unknown>) => c.text as string)
			.join("\n");
	}
	return String(content);
}

// ── 错误分类 ──

function classifyError(err: unknown): McpCallResult {
	const msg = err instanceof Error ? err.message : String(err);
	let errorType: McpCallResult["errorType"] = "unknown";

	if (/timeout|timed out|ETIMEDOUT|abort/i.test(msg)) {
		errorType = "timeout";
	} else if (/tool.*not found|unknown tool|ENOTFOUND/i.test(msg)) {
		errorType = "tool_not_found";
	} else if (/validation|invalid.*param|schema/i.test(msg)) {
		errorType = "validation_error";
	} else if (/5\d\d|server error|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
		errorType = "server_error";
	}

	return { text: msg, isError: true, errorType };
}

/**
 * Issue 012 review: UE MCP 有时把错误作为"成功"结果返回
 * (SDK 层 isError=false, 但 text 含错误标记, 如 "[server_error] Parameter error: ...")。
 * 扩展必须识别这些文本标记, 否则 journal 会把失败写记成成功。
 *
 * 已观察到的格式 (2026-08-14 session):
 *   [server_error] Parameter error: <path> is not valid Object for property 'instance'.
 *   [unknown] MCP error -32000: Connection closed
 *   [timeout] request exceeded 60000ms
 *
 * 返回 { isError: true, errorType } 表示 text 携带错误; 否则 { isError: false }。
 */
export function classifyResultText(text: string): { isError: boolean; errorType?: McpCallResult["errorType"] } {
	const trimmed = text.trim();
	if (trimmed === "") return { isError: false };

	// 带 [errorType] 前缀
	const m = trimmed.match(/^\[(server_error|validation_error|tool_not_found|timeout|unknown)\]\s*(.*)$/);
	if (m) {
		let errorType = m[1] as McpCallResult["errorType"];
		const body = m[2];
		// UE 用 [server_error] 前缀包装参数错误 — 实为校验错误, 不应触发重连重试
		if (/Parameter error/i.test(body)) {
			errorType = "validation_error";
		} else if (/MCP error -32000|connection closed/i.test(body)) {
			// [unknown] MCP error -32000: Connection closed — 连接层错误, 应触发重连
			errorType = "server_error";
		}
		return { isError: true, errorType };
	}

	// 无前缀但明显是错误文本
	if (/^Parameter error:/i.test(trimmed)) return { isError: true, errorType: "validation_error" };
	if (/^MCP error -32000:/i.test(trimmed)) return { isError: true, errorType: "server_error" };

	return { isError: false };
}

// ── UeClient 类 ──

export class UeClient  implements UeToolCaller {
	private client: Client | null = null;
	private transport: StreamableHTTPClientTransport | null = null;
	private config: UeHarnessConfig;

	constructor(config: UeHarnessConfig) {
		this.config = config;
	}

	get maxReconnect(): number {
		return this.config.ueMcpReconnectMax ?? 3;
	}

	// ── 连接管理 ──

	async connect(): Promise<void> {
		this.transport = new StreamableHTTPClientTransport(new URL(this.config.ueMcpUrl), {
			requestInit: {
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
				},
			},
		});

		this.client = new Client({ name: "ue-harness-pi-extension", version: "0.1.0" }, { capabilities: {} });

		await this.client.connect(this.transport);
	}

	async disconnect(): Promise<void> {
		try {
			await this.client?.close();
		} catch {
			// ignore close errors
		}
		this.client = null;
		this.transport = null;
	}

	/** 带指数退避的重连 */
	async reconnect(): Promise<boolean> {
		await this.disconnect();

		for (let i = 0; i < this.maxReconnect; i++) {
			const delay = Math.min(1000 * 2 ** i, 10000);
			await new Promise((r) => setTimeout(r, delay));

			try {
				await this.connect();
				return true;
			} catch {
				// retry next iteration
			}
		}

		return false; // 全部失败
	}

	// ── 工具发现 ──

	/**
	 * 获取全部 UE 工具定义 (含延迟加载)。
	 * 流程: list_toolsets → 逐个 load_toolset → 等待注册 → re-list tools
	 */
	async listAllTools(): Promise<UeToolDefinition[]> {
		if (!this.client) throw new Error("UeClient not connected");

		// Step 1: 获取工具集列表
		const tsResult = await this.client.callTool({ name: "list_toolsets", arguments: {} });
		const tsText = extractText(tsResult.content);
		const tsNames = parseToolsetNames(tsText);

		// Step 2: 加载所有工具集
		for (const name of tsNames) {
			try {
				await this.client.callTool({ name: "load_toolset", arguments: { toolset_name: name } });
			} catch {
				// 某些工具集可能加载失败 (如 plugin 未启用) → 忽略
			}
		}

		// Step 3: 等待 UE 完成工具注册 (异步)
		await new Promise((r) => setTimeout(r, 500));

		// Step 4: 重新获取完整工具列表
		const toolsResult = await this.client.listTools({});
		return toolsResult.tools.map((t) => ({
			name: t.name,
			description: t.description ?? "",
			inputSchema: (t.inputSchema as UeToolDefinition["inputSchema"]) ?? { type: "object" },
		})) as UeToolDefinition[];
	}

	// ── 工具调用 ──

	/** 调用 UE MCP 工具 (SSE event-stream → 解析 text content → returnValue 解包) */
	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		if (!this.client) throw new Error("UeClient not connected");

		try {
			const timeoutMs = this.config.ueMcpTimeoutMs ?? 60000;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			const result = await this.client.callTool(
				{
					name,
					arguments: args,
				},
				undefined,
				{ signal: controller.signal },
			);

			clearTimeout(timer);

			const text = extractText(result.content);

			// 检查 UE 侧错误: SDK isError 或文本错误标记 (见 classifyResultText)
			const classified = classifyResultText(text);
			if (result.isError || classified.isError) {
				return {
					text,
					isError: true,
					errorType: result.isError ? "server_error" : classified.errorType,
				};
			}

			return { text, isError: false };
		} catch (err) {
			return classifyError(err);
		}
	}

	/** 尝试调用，失败时自动重连一次后重试 */
	async callToolWithRetry(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		const result = await this.callTool(name, args);

		if (result.errorType === "server_error") {
			const reconnected = await this.reconnect();
			if (reconnected) {
				return this.callTool(name, args);
			}
		}

		return result;
	}

	get isConnected(): boolean {
		return this.client !== null;
	}
}
