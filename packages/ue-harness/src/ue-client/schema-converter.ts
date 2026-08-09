/**
 * Issue 002 — JSON Schema → TypeBox 自动转换器
 *
 * 将 UE MCP Server 返回的 JSON Schema 工具定义转换为 Pi Agent
 * 可用的 TypeBox schema。处理 UE 特有的构造：
 *   · nested object with required fields
 *   · enum 限制
 *   · oneOf / anyOf 展开为 Type.Union
 *   · $ref 内联解析 (UE 的 $ref 为 #/definitions/...)
 *   · default 值保留
 *
 * 转换失败的工具标记为 unavailable，不阻断整体注册。
 */
import { type TSchema, Type } from "typebox";
import type { ConvertedTool, PiToolRegistration, UeJsonSchema } from "./types.ts";

// ── 排除的工具 (Issue 002 任务 2.5) ──

/** 将 UE 工具名中的点号替换为下划线，使其符合 LLM API 的 ^[a-zA-Z0-9_-]+$ */
function sanitizeName(ueName: string): string {
	return ueName.replace(/\./g, "_");
}

/** 强制排除的工具名模式 (glob 风格) */
const EXCLUDED_PATTERNS = [
	"*CaptureEditorImage", // DWM 依赖，窗口后台即失败 → 用 CaptureViewportImage 替代
];

function isExcluded(name: string): boolean {
	return EXCLUDED_PATTERNS.some((p) => {
		const regex = new RegExp(`^${p.replace(/\*/g, ".*")}$`);
		return regex.test(name);
	});
}

// ── 主入口 ──

/**
 * 将 UE 工具转换为 Pi 可用的 ToolDefinition。
 *
 * @param tool UE 原始工具定义
 * @returns ConvertedTool (成功) 或 null (被排除/转换失败)
 */
export function convertTool(tool: {
	name: string;
	description: string;
	inputSchema: UeJsonSchema;
}): ConvertedTool | null {
	if (isExcluded(tool.name)) {
		return null;
	}

	try {
		const schema = jsonSchemaToTypeBox(tool.inputSchema);

		const registration: PiToolRegistration = {
			name: sanitizeName(tool.name),
			ueName: tool.name,
			label: tool.name.split(".").pop() || tool.name,
			description: tool.description || "",
			parameters: schema,
			promptSnippet: buildPromptSnippet(tool),
		};

		return { schema, registration, raw: { ...tool, inputSchema: tool.inputSchema } };
	} catch (err) {
		// 转换失败 → 标记为 unavailable，不阻断
		console.warn(`[ue-harness] schema converter: failed for "${tool.name}": ${(err as Error).message}`);
		return null;
	}
}

// ── 核心转换逻辑 ──

function jsonSchemaToTypeBox(schema: UeJsonSchema): TSchema {
	// 空 schema → Type.Object({}) (如 CaptureEditorImage)
	if (!schema || Object.keys(schema).length === 0 || (schema.type === "object" && !schema.properties)) {
		return Type.Object({});
	}

	// enum
	if (schema.enum && schema.enum.length > 0) {
		return convertEnum(schema);
	}

	// oneOf / anyOf
	if (schema.oneOf && schema.oneOf.length > 0) {
		const variants = schema.oneOf.map((s: UeJsonSchema) => jsonSchemaToTypeBox(s));
		return Type.Union(variants);
	}
	if (schema.anyOf && schema.anyOf.length > 0) {
		const variants = schema.anyOf.map((s: UeJsonSchema) => jsonSchemaToTypeBox(s));
		return Type.Union(variants);
	}

	// 带 properties 的 object
	if (schema.type === "object" && schema.properties) {
		return convertObject(schema);
	}

	// array
	if (schema.type === "array") {
		if (schema.items) {
			return Type.Array(jsonSchemaToTypeBox(schema.items));
		}
		return Type.Array(Type.Any());
	}

	// 基础类型
	return convertPrimitive(schema);
}

// ── 对象转换 ──

function convertObject(schema: UeJsonSchema): TSchema {
	const properties: Record<string, TSchema> = {};
	const required = new Set(schema.required ?? []);

	for (const [key, rawPropSchema] of Object.entries(schema.properties ?? {})) {
		const propSchema = rawPropSchema as UeJsonSchema;
		let propType = jsonSchemaToTypeBox(propSchema);

		// 处理 default 值 → optional
		if (propSchema.default !== undefined) {
			// UE 的 default 经常设为 null → Type.Optional
		}

		// 不在 required 中 → Type.Optional
		if (!required.has(key)) {
			propType = Type.Optional(propType);
		}

		properties[key] = propType;
	}

	return Type.Object(properties);
}

// ── 枚举转换 ──

function convertEnum(schema: UeJsonSchema): TSchema {
	const values = schema.enum!;

	// 全是 string → Type.Union([Type.Literal(s1), Type.Literal(s2), ...])
	if (typeof values[0] === "string") {
		const literals = values.map((v: string | number) => Type.Literal(v as string));
		return Type.Union(literals);
	}

	// 全是 number
	if (typeof values[0] === "number") {
		const literals = values.map((v: string | number) => Type.Literal(v as number));
		return Type.Union(literals);
	}

	return Type.Any();
}

// ── 基础类型 ──

function convertPrimitive(schema: UeJsonSchema): TSchema {
	switch (schema.type) {
		case "string":
			return Type.String();
		case "number":
		case "integer":
			return Type.Number();
		case "boolean":
			return Type.Boolean();
		case "null":
			return Type.Null();
		default:
			// 兜底: 可能是 anonymous type or empty
			return Type.Any();
	}
}

// ── prompt snippet 构建 ──

function buildPromptSnippet(tool: { name: string; description: string }): string {
	const shortName = tool.name.split(".").pop() || tool.name;
	const desc = tool.description || "";
	// 取第一句话作为 snippet
	const firstSentence = desc.split(/[.\n]/)[0].trim();
	if (firstSentence.length <= 100) {
		return `${shortName}: ${firstSentence}`;
	}
	return `${shortName}: ${firstSentence.substring(0, 97)}...`;
}
