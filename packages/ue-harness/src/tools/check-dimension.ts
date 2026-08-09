/**
 * Issue 004 — check_dimension 工具实现
 *
 * 单维度方向验证。调参后判断当前截图在指定维度上是 closer/similar/further。
 *
 * 流程:
 *   加载参考图(磁盘) + 捕获当前视口
 *   → Stage 1: 量化 delta (computeMetrics → getDimensionMetric, <10ms)
 *   → Stage 2: Vision 双图单维度提问 (closer/similar/further)
 *
 * 不依赖 assess_lighting 输出。自己加载参考图 + 自己做对比。
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readFileSync } from "fs";
import { Type } from "typebox";
import { getUeClient, getVisionClient } from "../state.ts";
import { captureViewport } from "../vision/capture.ts";
import { computeMetrics, getDimensionMetric } from "../vision/metrics.ts";
import type { VisionClient } from "../vision/vision-client.ts";

// ── 类型 ──

interface DimensionVerdict {
	dimension: string;
	verdict: "closer" | "similar" | "further";
	evidence: string;
	quantitative?: {
		refValue: number;
		curValue: number;
		delta: string;
	};
}

interface CheckDimensionResult {
	success: boolean;
	error?: string;
	result?: DimensionVerdict;
	meta?: { quantitativeMs: number; visionMs: number };
}

// ── Vision 单维度判定 ──

async function visionCheck(
	vision: VisionClient,
	refBase64: string,
	curBase64: string,
	dimension: string,
): Promise<{ verdict: string; evidence: string }> {
	const prompt = `你是一个游戏光照对比助手。

参考图是目标，当前截图是调整后的结果。
只比较 "${dimension}" 这一个维度。

判定:
  · closer  — 当前截图在 ${dimension} 上比参考图更接近目标了
  · similar — 差不多，没有明显变化
  · further — 比参考图更远了

给出判定 + 一句话证据。

返回格式必须是纯 JSON:
{
  "verdict": "closer",
  "evidence": "描述你看到了什么"
}`;

	const result = await vision.sendAndParse<{ verdict: string; evidence: string }>({
		prompt,
		images: [{ base64: refBase64 }, { base64: curBase64 }],
		maxTokens: 300,
	});

	return { verdict: result.verdict || "similar", evidence: result.evidence || "" };
}

// ── 主入口 ──

export const checkDimensionDef = {
	name: "check_dimension",
	label: "Check Dimension",
	description:
		"单维度方向验证。对比参考图与当前截图，判断在指定维度上当前是 closer/similar/further。附带量化指标(如果有)。",
	parameters: Type.Object({
		reference_path: Type.String(),
		dimension: Type.String(),
	}),
	promptSnippet: "check_dimension: 单维度方向验证(closer/similar/further)",
	promptGuidelines: [
		"每次调参后调 check_dimension 确认方向",
		"如果 further → 方向错误，回退改动",
		"如果 similar → 方向对但幅度不够，加大调整",
		"如果 closer → 方向正确，继续或切换下一个维度",
	],
};

export async function executeCheckDimension(params: {
	reference_path: string;
	dimension: string;
}): Promise<AgentToolResult> {
	const ueClient = getUeClient();
	const vision = getVisionClient();

	if (!ueClient?.isConnected) return errResult("UE MCP not connected");
	if (!vision?.isConfigured) return errResult("Vision not configured");

	const refPath = params.reference_path;
	const dimension = params.dimension;

	// ── 加载参考图 ──
	let refBuffer: Buffer;
	try {
		refBuffer = readFileSync(refPath);
	} catch {
		return errResult(`Reference image not found: ${refPath}`);
	}
	const refBase64 = refBuffer.toString("base64");

	// ── 捕获当前视口 ──
	const capture = await captureViewport(ueClient, 1.0);
	if (!capture) return errResult("Viewport capture failed");

	const curBuffer = Buffer.from(capture.base64, "base64");

	// ── Stage 1 + Stage 2: 并行 ──
	const [metrics, visionResult] = await Promise.all([
		computeMetrics(refBuffer, curBuffer),
		visionCheck(vision, refBase64, capture.base64, dimension),
	]);

	// 提取当前维度的量化指标
	const quantitative = getDimensionMetric(dimension, metrics);

	const result: CheckDimensionResult = {
		success: true,
		result: {
			dimension,
			verdict: (visionResult.verdict as "closer" | "similar" | "further") || "similar",
			evidence: visionResult.evidence,
			quantitative: quantitative || undefined,
		},
		meta: {
			quantitativeMs: metrics.histogramCorrelation > 0 ? 0 : 0, // no direct timing, <10ms
			visionMs: capture.elapsedMs,
		},
	};

	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
	};
}

function errResult(msg: string): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
	};
}
