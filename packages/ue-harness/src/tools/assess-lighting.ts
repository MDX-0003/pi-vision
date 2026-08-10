/**
 * Issue 003 — assess_lighting 工具实现
 *
 * 核心 Vision 工具。对比参考图与当前截图，输出每维度 gap 报告。
 *
 * 流程:
 *   Stage 1 (量化指标)  +  Stage 2 (Vision 主观)  →  并行执行
 *   → 特征对比 (rating diff → gap level)
 *   → artificiality 检测
 *   → 结构化 JSON 输出
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readFileSync } from "fs";
import { Type } from "typebox";
import { getUeClient, getVisionClient } from "../state.ts";
import { captureViewport } from "../vision/capture.ts";
import { computeMetrics } from "../vision/metrics.ts";
import { ARTIFICIALITY_PROMPT, ATMOSPHERE_ANALYSIS_PROMPT } from "../vision/prompts.ts";
import type { VisionClient } from "../vision/vision-client.ts";

// ── 类型 ──

/** 8 维度氛围分析结果 */
interface AtmosphereAnalysis {
	[dimension: string]: {
		rating: number;
		description: string;
	};
}

/** artificiality 检测结果 */
interface ArtificialityResult {
	detected: boolean;
	detail: string;
}

/** 单个维度的 gap */
interface DimensionGap {
	dimension: string;
	tier: number;
	gap: "minor" | "moderate" | "major";
	direction: string;
	rating_diff: number;
	quantitative: {
		refValue: number;
		curValue: number;
		delta: string;
	} | null;
	qualitative: string | null;
}

/** assess_lighting 完整返回 */
export interface AssessLightingResult {
	success: boolean;
	error?: string;

	reference?: {
		path: string;
		atmosphere: AtmosphereAnalysis;
		fileSize: number;
	};

	current?: {
		atmosphere: AtmosphereAnalysis;
		filePath: string;
		fileSize: number;
	};

	gaps?: DimensionGap[];

	quantitative?: {
		reference: { luminance: number; colorTempRatio: number; saturation: number };
		current: { luminance: number; colorTempRatio: number; saturation: number };
		luminanceDelta: string;
		colorTempRatioDelta: string;
		saturationDelta: string;
		histogramCorrelation: number;
	};

	artificiality?: ArtificialityResult;

	blocking_dimensions?: string[];

	meta?: {
		visionTokens: number;
		captureMs: number;
		quantitativeMs: number;
		visionMs: number;
	};
}

// ── 维度 → Tier 映射 ──

const DIMENSION_TIER: Record<string, number> = {
	light_direction: 1,
	color_temperature: 1,
	brightness: 1,
	shadow_depth: 1,
	atmosphere: 2,
	contrast: 3,
	color_cast: 3,
	saturation: 3,
};

// ── 量化阈值 ──

/** 量化指标 delta 绝对值 → gap 级别 */
function quantitativeGap(dimension: string, deltaAbs: number): "minor" | "moderate" | "major" | null {
	switch (dimension) {
		case "brightness":
			if (deltaAbs <= 15) return "minor";
			if (deltaAbs <= 30) return "moderate";
			return "major";
		case "color_temperature":
			if (deltaAbs <= 0.15) return "minor";
			if (deltaAbs <= 0.4) return "moderate";
			return "major";
		case "saturation":
			if (deltaAbs <= 0.05) return "minor";
			if (deltaAbs <= 0.15) return "moderate";
			return "major";
		default:
			return null;
	}
}

// ── gap 判定 (Vision + 量化双路校验) ──

function computeGap(
	dimension: string,
	refRating: number,
	curRating: number,
	quantitativeDeltaAbs?: number,
): "minor" | "moderate" | "major" {
	const visionDiff = Math.abs(refRating - curRating);
	let visionGap: "minor" | "moderate" | "major";
	if (visionDiff >= 3) visionGap = "major";
	else if (visionDiff === 2) visionGap = "moderate";
	else visionGap = "minor";

	if (quantitativeDeltaAbs !== undefined) {
		const quantGap = quantitativeGap(dimension, quantitativeDeltaAbs);
		if (quantGap) {
			// 取两者中最严重的
			const severity: Record<string, number> = { minor: 0, moderate: 1, major: 2 };
			return severity[quantGap] > severity[visionGap] ? quantGap : visionGap;
		}
	}

	return visionGap;
}

function computeDirection(dimension: string, refRating: number, curRating: number): string {
	const diff = refRating - curRating; // positive = ref higher, negative = cur higher
	const map: Record<string, [string, string]> = {
		light_direction: ["closer_to_ref", "further_from_ref"],
		color_temperature: ["too_cool", "too_warm"],
		brightness: ["too_dark", "too_bright"],
		contrast: ["too_flat", "too_contrasty"],
		color_cast: ["less_cast", "more_cast"],
		saturation: ["less_saturated", "more_saturated"],
		atmosphere: ["too_clear", "too_hazy"],
		shadow_depth: ["too_shallow", "too_deep"],
	};

	const [whenRefHigher, whenCurHigher] = map[dimension] ?? ["below_ref", "above_ref"];
	if (diff === 0) return "close_enough";
	return diff > 0 ? whenRefHigher : whenCurHigher;
}

// ── 阻塞维度检测 ──

function findBlockers(
	gaps: DimensionGap[],
	artificiality: ArtificialityResult | undefined,
	histogramCorrelation: number,
): string[] {
	const blockers: string[] = [];

	// 规则 1: light_direction 如果 gap 非 minor 且直方图相关性低 → blocker
	const lightGap = gaps.find((g) => g.dimension === "light_direction");
	if (lightGap && lightGap.gap !== "minor" && histogramCorrelation < 0.5) {
		blockers.push("light_direction (太阳角度差异 — 必须先解决，否则其他维度调整无效)");
	}

	// 规则 2: color_temperature 为 major → blocker
	if (lightGap && lightGap.gap === "minor" && histogramCorrelation < 0.5) {
		// light_direction 评级低但直方图相关性也低 → 结构性不匹配，仍可能是角度问题
		if (!blockers.some((b) => b.startsWith("light_direction"))) {
			blockers.push("light_direction (太阳角度差异 — Vision 评分接近但直方图相关性低，可能存在结构性不匹配)");
		}
	}

	const colorGap = gaps.find((g) => g.dimension === "color_temperature");
	if (colorGap && colorGap.gap === "major") {
		blockers.push("color_temperature (全局色温偏差大 — 影响所有大气和雾的颜色表现)");
	}

	// 规则 3: artificiality → blocker
	if (artificiality?.detected) {
		blockers.push("post_processing (检测到人工滤镜感 — 回退 PostProcess 到默认值后重新评估)");
	}

	return blockers;
}

// ── helper ──

function computeOverallGap(histogramCorrelation: number): "major" | "moderate" | null {
	if (histogramCorrelation < 0.3) return "major";
	if (histogramCorrelation < 0.5) return "moderate";
	return null;
}

async function analyzeAtmosphere(vision: VisionClient, base64: string): Promise<AtmosphereAnalysis> {
	const result = await vision.sendAndParse<AtmosphereAnalysis>({
		prompt: ATMOSPHERE_ANALYSIS_PROMPT,
		images: [{ base64 }],
		maxTokens: 2000,
	});
	return result;
}

async function checkArtificiality(vision: VisionClient, base64: string): Promise<ArtificialityResult> {
	const result = await vision.sendAndParse<ArtificialityResult>({
		prompt: ARTIFICIALITY_PROMPT,
		images: [{ base64 }],
		maxTokens: 300,
	});
	return result;
}

// ── 主入口: ToolDefinition + execute ──

export const assessLightingDef = {
	name: "assess_lighting",
	label: "Assess Lighting",
	description:
		"对比参考图与当前场景截图，输出每个光照维度的差距报告。" +
		"包含量化指标（亮度/色温比/饱和度/直方图相关性）和 Vision 主观评估（8个维度1-5评分）",
	parameters: Type.Object({
		reference_path: Type.String(),
	}),
	promptSnippet: "assess_lighting: 对比参考图与当前场景，输出每维度光照差距报告",
	promptGuidelines: [
		"首次调用 assess_lighting 前必须先调 map_atmosphere 了解可调参数",
		"assess_lighting 会消耗 Vision token，仅在需要全局判断时调用",
		"调整单个参数后优先用 check_dimension 做单维度快速验证",
	],
};

export async function executeAssessLighting(params: { reference_path: string }): Promise<AgentToolResult> {
	const ueClient = getUeClient();
	const vision = getVisionClient();

	if (!ueClient?.isConnected) {
		return errResult("UE MCP not connected");
	}
	if (!vision?.isConfigured) {
		return errResult("VISION_API_KEY not configured");
	}

	const refPath = params.reference_path;
	const meta = { visionTokens: 0, captureMs: 0, quantitativeMs: 0, visionMs: 0 };

	// ── 加载参考图 ──
	let refBuffer: Buffer;
	try {
		refBuffer = readFileSync(refPath);
	} catch {
		return errResult(`Reference image not found: ${refPath}`);
	}
	const refBase64 = refBuffer.toString("base64");

	// ── 捕获当前截图 ──
	const capture = await captureViewport(ueClient, 1.0);
	if (!capture) {
		return errResult("Viewport capture failed");
	}
	meta.captureMs = capture.elapsedMs;

	// ════════════════════════════════════════════════
	// Stage 1 + Stage 2: 并行执行
	// ════════════════════════════════════════════════
	const qStart = Date.now();
	const [quantMetrics, refAtmosphere, curAtmosphere, artificiality] = await Promise.all([
		// Stage 1: 量化指标
		computeMetrics(refBuffer, Buffer.from(capture.base64, "base64")),
		// Stage 2a: 参考图氛围分析
		analyzeAtmosphere(vision, refBase64),
		// Stage 2b: 当前截图氛围分析
		analyzeAtmosphere(vision, capture.base64),
		// artificiality 检测
		checkArtificiality(vision, capture.base64),
	]);
	meta.quantitativeMs = Date.now() - qStart;

	// ════════════════════════════════════════════════
	// 特征对比: rating diff → gap
	// ════════════════════════════════════════════════
	const gaps: DimensionGap[] = [];

	for (const [dim, refData] of Object.entries(refAtmosphere)) {
		const curData = curAtmosphere[dim];
		if (!curData || typeof refData.rating !== "number" || typeof curData.rating !== "number") continue;

		const refRating = refData.rating;
		const curRating = curData.rating;
		const ratingDiff = refRating - curRating;
		const tier = DIMENSION_TIER[dim] ?? 99;

		// 量化数据 (只有部分维度有) + 量化 delta 绝对值 (用于交叉校验)
		let quantitative: DimensionGap["quantitative"] = null;
		let quantDeltaAbs: number | undefined;
		if (dim === "brightness") {
			quantDeltaAbs = Math.abs(quantMetrics.luminanceDelta);
			quantitative = {
				refValue: quantMetrics.reference.luminance,
				curValue: quantMetrics.current.luminance,
				delta: `${quantMetrics.luminanceDelta > 0 ? "+" : ""}${quantMetrics.luminanceDelta.toFixed(1)}%`,
			};
		} else if (dim === "color_temperature") {
			quantDeltaAbs = Math.abs(quantMetrics.colorTempRatioDelta);
			quantitative = {
				refValue: quantMetrics.reference.colorTempRatio,
				curValue: quantMetrics.current.colorTempRatio,
				delta: `${quantMetrics.colorTempRatioDelta > 0 ? "+" : ""}${quantMetrics.colorTempRatioDelta.toFixed(2)}`,
			};
		} else if (dim === "saturation") {
			quantDeltaAbs = Math.abs(quantMetrics.saturationDelta);
			quantitative = {
				refValue: quantMetrics.reference.saturation,
				curValue: quantMetrics.current.saturation,
				delta: `${quantMetrics.saturationDelta > 0 ? "+" : ""}${quantMetrics.saturationDelta.toFixed(3)}`,
			};
		}

		gaps.push({
			dimension: dim,
			tier,
			gap: computeGap(dim, refRating, curRating, quantDeltaAbs),
			direction: computeDirection(dim, refRating, curRating),
			rating_diff: Math.abs(ratingDiff),
			quantitative,
			qualitative: Math.abs(ratingDiff) >= 2 ? `${refData.description} vs ${curData.description}` : null,
		});
	}

	// 直方图相关性低 → 追加整体结构不匹配 pseudo-gap
	const overallGap = computeOverallGap(quantMetrics.histogramCorrelation);
	if (overallGap) {
		gaps.push({
			dimension: "overall_composition",
			tier: 0,
			gap: overallGap,
			direction: "structural_mismatch",
			rating_diff: 0,
			quantitative: null,
			qualitative:
				"画面整体色调分布与参考图差异大。即使各维度 gap 都小，也可能存在结构性不匹配（如太阳角度、场景几何、参考图场景中的特殊元素）。",
		});
	}

	// 阻塞维度检测
	const blockingDimensions = findBlockers(gaps, artificiality, quantMetrics.histogramCorrelation);

	// 按 gap severity + tier 排序
	gaps.sort((a, b) => {
		const severityOrder = { major: 0, moderate: 1, minor: 2 };
		const sa = severityOrder[a.gap];
		const sb = severityOrder[b.gap];
		if (sa !== sb) return sa - sb;
		return a.tier - b.tier;
	});

	meta.visionTokens = 3 * 2000; // 3 Vision calls (ref, cur, artificiality) @ ~2000 each

	const result: AssessLightingResult = {
		success: true,
		reference: {
			path: refPath,
			atmosphere: refAtmosphere,
			fileSize: refBuffer.length,
		},
		current: {
			atmosphere: curAtmosphere,
			filePath: capture.filePath,
			fileSize: capture.fileSize,
		},
		gaps,
		quantitative: {
			reference: {
				luminance: quantMetrics.reference.luminance,
				colorTempRatio: quantMetrics.reference.colorTempRatio,
				saturation: quantMetrics.reference.saturation,
			},
			current: {
				luminance: quantMetrics.current.luminance,
				colorTempRatio: quantMetrics.current.colorTempRatio,
				saturation: quantMetrics.current.saturation,
			},
			luminanceDelta: `${quantMetrics.luminanceDelta > 0 ? "+" : ""}${quantMetrics.luminanceDelta.toFixed(1)}%`,
			colorTempRatioDelta: `${quantMetrics.colorTempRatioDelta > 0 ? "+" : ""}${quantMetrics.colorTempRatioDelta.toFixed(2)}`,
			saturationDelta: `${quantMetrics.saturationDelta > 0 ? "+" : ""}${quantMetrics.saturationDelta.toFixed(3)}`,
			histogramCorrelation: quantMetrics.histogramCorrelation,
		},
		artificiality,
		blocking_dimensions: blockingDimensions,
		meta,
	};

	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
	};
}

function errResult(msg: string): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
		isError: true,
	};
}
