/**
 * Issue 008a — Vision 标签分析器
 *
 * 将图片（base64）通过 Vision API 转换为结构化标签。
 * 是"分析图片 → 生成标签"的唯一入口——被参考图分析和预设保存复用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { buildTaggingPrompt } from "./prompts.ts";
import type { VisionClient } from "./vision-client.ts";

// ═══════════════════════════════════════════
// 编译时基础词汇表
// ═══════════════════════════════════════════

export const BASE_TAG_VALUES = {
	time_of_day: ["golden_hour", "midday", "dusk", "night", "dawn", "overcast", "unspecified"],
	color_palette: ["warm", "cool", "neutral", "warm_cool_contrast", "unspecified"],
	atmosphere: ["clear", "light_fog", "heavy_fog", "mist", "haze", "storm", "unspecified"],
	light_direction: ["front", "side", "back", "top", "ambient", "low_angle", "unspecified"],
	mood: ["bright", "dark", "moody", "vibrant", "muted", "dramatic", "unspecified"],
} as const;

export type ControlledTagDimension = keyof typeof BASE_TAG_VALUES;

export const CONTROLLED_DIMENSIONS: ControlledTagDimension[] = [
	"time_of_day",
	"color_palette",
	"atmosphere",
	"light_direction",
	"mood",
];

// ═══════════════════════════════════════════
// 运行时扩展词汇表
// ═══════════════════════════════════════════

const VOCABULARY_PATH = join(homedir(), ".pi", "agent", "tag-vocabulary.json");
const ALIASES_PATH = join(homedir(), ".pi", "agent", "tag-aliases.json");

let _customVocabulary: Record<string, string[]> = {};
let _aliases: Record<string, Record<string, string>> = {};

/** session_start 时调用：从磁盘加载自定义词汇和别名 */
export function loadCustomVocabulary(): void {
	try {
		if (existsSync(VOCABULARY_PATH)) {
			_customVocabulary = JSON.parse(readFileSync(VOCABULARY_PATH, "utf-8"));
		}
	} catch {
		/* 文件不存在或损坏 → 保持空，不报错 */
	}

	try {
		if (existsSync(ALIASES_PATH)) {
			_aliases = JSON.parse(readFileSync(ALIASES_PATH, "utf-8"));
		}
	} catch {
		/* 同上 */
	}
}

function writeVocabularyFile(): void {
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(VOCABULARY_PATH, JSON.stringify(_customVocabulary, null, 2), "utf-8");
}

/** 获取合并后的有效词汇表（基础 + 自定义） */
export function getEffectiveVocabulary(dim: ControlledTagDimension): string[] {
	const base = [...BASE_TAG_VALUES[dim]];
	const custom = _customVocabulary[dim] ?? [];
	return [...new Set([...base, ...custom])];
}

/** 运行时校验标签值是否合法 */
export function isValidTagValue(dim: ControlledTagDimension, value: string): boolean {
	return getEffectiveVocabulary(dim).includes(value);
}

/** 运行时新增自定义标签（008f approve_tag 调用，内存立即生效 + 写入文件） */
export function addCustomTag(dim: ControlledTagDimension, value: string): void {
	if (!_customVocabulary[dim]) _customVocabulary[dim] = [];
	if (!_customVocabulary[dim].includes(value)) {
		_customVocabulary[dim].push(value);
		writeVocabularyFile();
	}
}

// ═══════════════════════════════════════════
// 类型（宽松 string，运行时校验保底）
// ═══════════════════════════════════════════

export interface PresetTags {
	time_of_day: string;
	color_palette: string;
	atmosphere: string;
	light_direction: string;
	mood: string;
}

export interface TagValidation {
	isValid: boolean;
	unknownTags: Array<{ dimension: ControlledTagDimension; value: string }>;
}

export interface TagResult {
	/** 1-3 句自然语言摘要，给 LLM 阅读 */
	description: string;
	/** 受控标签，用于代码层精确匹配 */
	tags: PresetTags;
	/** 自由标签（0-5 个），加分项 */
	freeformTags: string[];
	/** 运行时校验结果 */
	validation: TagValidation;
}

// ═══════════════════════════════════════════
// 别名映射
// ═══════════════════════════════════════════

function applyAlias(dim: ControlledTagDimension, rawValue: string): string | null {
	return _aliases[dim]?.[rawValue] ?? null;
}

// ═══════════════════════════════════════════
// 校验（导出供测试使用）
// ═══════════════════════════════════════════

export function validateTags(raw: Record<string, unknown>): TagResult {
	const tags: PresetTags = {
		time_of_day: "unspecified",
		color_palette: "unspecified",
		atmosphere: "unspecified",
		light_direction: "unspecified",
		mood: "unspecified",
	};
	const unknownTags: TagValidation["unknownTags"] = [];

	for (const dim of CONTROLLED_DIMENSIONS) {
		const rawValue = String(raw[dim] ?? "unspecified");

		// Step 1: 别名映射
		const aliased = applyAlias(dim, rawValue);
		if (aliased && isValidTagValue(dim, aliased)) {
			tags[dim] = aliased;
			continue;
		}

		// Step 2: 直接合法
		if (isValidTagValue(dim, rawValue)) {
			tags[dim] = rawValue;
			continue;
		}

		// Step 3: 未知值 → 降级 + 记录
		tags[dim] = "unspecified";
		unknownTags.push({ dimension: dim, value: rawValue });
	}

	return {
		description: String(raw.description ?? ""),
		tags,
		freeformTags: Array.isArray(raw.freeformTags) ? raw.freeformTags : [],
		validation: { isValid: unknownTags.length === 0, unknownTags },
	};
}

// ═══════════════════════════════════════════
// 测试辅助（仅供测试使用）
// ═══════════════════════════════════════════

/** 重置运行时状态（测试隔离用） */
export function _resetForTest(): void {
	_customVocabulary = {};
	_aliases = {};
}

/** 直接设置自定义词汇（测试隔离用） */
export function _setCustomVocabulary(vocab: Record<string, string[]>): void {
	_customVocabulary = vocab;
}

/** 直接设置别名（测试隔离用） */
export function _setAliases(aliases: Record<string, Record<string, string>>): void {
	_aliases = aliases;
}

// ═══════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════

/**
 * 分析单张图片，返回结构化标签。
 * 被以下场景复用:
 *   - 参考图分析（assess_lighting 流程中并行调用）
 *   - 预设保存（save_preset 流程中分析截图）
 *   - 预设重分析（008f reanalyze_preset）
 */
export async function analyzeAndTag(
	visionClient: VisionClient,
	imageBase64: string,
): Promise<TagResult> {
	const raw = await visionClient.sendAndParse<Record<string, unknown>>({
		prompt: buildTaggingPrompt(),
		images: [{ base64: imageBase64 }],
	});
	return validateTags(raw);
}
