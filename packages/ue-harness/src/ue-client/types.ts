/**
 * Issue 002 — 共享类型定义
 *
 * UE MCP 工具的 JSON Schema 结构、TypeBox 转换结果、
 * MCP Client 包装类型、扩展注册元数据。
 */
import type { TSchema } from "typebox";

// ── UE MCP 原始类型 ──

/** UE MCP Server 返回的原始工具定义 (tools/list 中的单个工具) */
export interface UeToolDefinition {
	name: string;
	description: string;
	inputSchema: UeJsonSchema;
}

/** UE MCP 使用的 JSON Schema 子集 */
export interface UeJsonSchema {
	type?: string;
	title?: string;
	description?: string;
	properties?: Record<string, UeJsonSchema>;
	items?: UeJsonSchema;
	required?: string[];
	enum?: (string | number)[];
	default?: unknown;
	// UE 特有构造
	oneOf?: UeJsonSchema[];
	anyOf?: UeJsonSchema[];
	$ref?: string;
}

// ── 转换结果 ──

/** JSON Schema → TypeBox 转换结果 */
export interface ConvertedTool {
	/** TypeBox 编译后的 schema */
	schema: TSchema;
	/** Pi 工具注册所需的完整定义 */
	registration: PiToolRegistration;
	/** 原始 UE 定义 (保留用于调试) */
	raw: UeToolDefinition;
}

/** Pi Agent 工具注册格式 */
export interface PiToolRegistration {
	/** Pi/LLM 使用的净化名（点号→下划线，符合 ^[a-zA-Z0-9_-]+$） */
	name: string;
	/** UE MCP 原始工具名（含点号），用于 callTool */
	ueName: string;
	label: string;
	description: string;
	parameters: TSchema;
	/** 可用于构造 system prompt 中的工具列表 */
	promptSnippet?: string;
}

// ── MCP Client 类型 ──

/** MCP 工具调用结果 (简化版) */
export interface McpCallResult {
	/** 纯文本内容 (从 SSE event-stream 解析) */
	text: string;
	/** 是否包含错误 */
	isError: boolean;
	/** 错误的分类 (如果有) */
	errorType?: "timeout" | "server_error" | "tool_not_found" | "validation_error" | "unknown";
}

// ── 扩展配置类型 ──

export interface UeHarnessConfig {
	ueMcpUrl: string;
	visionApiKey?: string;
	visionApiBaseUrl?: string;
	visionModelId?: string;
	visionMaxTokens?: number;
	ueMcpTimeoutMs?: number;
	ueMcpReconnectMax?: number;
}
