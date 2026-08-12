/**
 * Issue 008a — Vision 标签分析器
 *
 * 将图片（base64）通过 Vision API 转换为结构化标签。
 * 是"分析图片 → 生成标签"的唯一入口——被参考图分析和预设保存复用。
 */
import { buildTaggingPrompt } from "./prompts.ts";
import type { VisionClient } from "./vision-client.ts";

// ═══════════════════════════════════════════
// Issue 010a — 简化类型（开放式标签，无受控维度）
// ═══════════════════════════════════════════

export interface TagResult {
	/** 1-2 句中文描述，给 LLM 阅读 */
	description: string;
	/** 开放式标签（0-5 个），用于与预设库匹配 */
	tags: string[];
}

// ═══════════════════════════════════════════
// 校验（导出供测试使用）
// ═══════════════════════════════════════════

export function validateTags(raw: Record<string, unknown>): TagResult {
	return {
		description: String(raw.description ?? ""),
		tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string").slice(0, 5) : [],
	};
}

// ═══════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════

/**
 * 分析单张图片，返回开放式标签。
 * 被以下场景复用:
 *   - 参考图分析（assess_lighting 流程中并行调用）
 *   - 预设保存（save_preset 流程中分析截图）
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
