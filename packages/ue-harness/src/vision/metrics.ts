/**
 * Issue 003 — 量化指标计算
 *
 * 使用 sharp 实现 4 项全图统计指标。
 * 纯同步同步计算，<10ms，不调用 Vision API。
 *
 * 注意：这些指标测量的是"光照氛围"相关的全局统计量，
 * 不假设参考图与当前截图有相同的画面内容。
 * 因此不包含像素级对比（如 SSIM/diff），只包含统计分布对比。
 */
import sharp from "sharp";

// ── 类型 ──

/** 单张图片的量化统计 */
export interface ImageStats {
	/** 亮度均值 (0-255) */
	luminance: number;
	/** 红色通道均值 / 蓝色通道均值 (R/B 比 ≈ 色温指标) */
	colorTempRatio: number;
	/** 饱和度均值 (标准差的归一化表示, 0-1) */
	saturation: number;
}

/** 两张图片的量化对比 */
export interface QuantitativeComparison {
	reference: ImageStats;
	current: ImageStats;
	luminanceDelta: number; // (cur - ref) / ref * 100
	colorTempRatioDelta: number; // cur - ref
	saturationDelta: number; // cur - ref
	histogramCorrelation: number; // 0-1, 1 = 完全一致
}

// ── 主入口 ──

/**
 * 计算两张图片的量化对比指标。
 *
 * @param refBuffer 参考图 PNG buffer
 * @param curBuffer 当前截图 PNG buffer
 */
export async function computeMetrics(refBuffer: Buffer, curBuffer: Buffer): Promise<QuantitativeComparison> {
	const [refStats, curStats] = await Promise.all([computeImageStats(refBuffer), computeImageStats(curBuffer)]);

	const luminanceDelta = ((curStats.luminance - refStats.luminance) / refStats.luminance) * 100;
	const colorTempRatioDelta = curStats.colorTempRatio - refStats.colorTempRatio;
	const saturationDelta = curStats.saturation - refStats.saturation;
	const histogramCorrelation = await computeHistogramCorrelation(refBuffer, curBuffer);

	return {
		reference: refStats,
		current: curStats,
		luminanceDelta,
		colorTempRatioDelta,
		saturationDelta,
		histogramCorrelation,
	};
}

/** 获取单张图片的量化统计 */
export async function computeImageStats(buffer: Buffer): Promise<ImageStats> {
	const { data, info } = await sharp(buffer)
		.resize(1024, 1024, { fit: "inside" }) // 缩放到 512px 加速计算
		.raw()
		.toBuffer({ resolveWithObject: true });

	const channels = info.channels; // 3 (RGB) or 4 (RGBA)
	const pixelCount = info.width * info.height;

	let sumR = 0,
		_sumG = 0,
		sumB = 0;
	let sumLuminance = 0;

	for (let i = 0; i < data.length; i += channels) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];

		sumR += r;
		_sumG += g;
		sumB += b;
		// 感知亮度 = 0.299*R + 0.587*G + 0.114*B
		sumLuminance += 0.299 * r + 0.587 * g + 0.114 * b;
	}

	const avgLuminance = sumLuminance / pixelCount;
	const avgR = sumR / pixelCount;
	const avgB = sumB / pixelCount;
	// R/B 比 > 1 → 偏暖, < 1 → 偏冷
	const colorTempRatio = avgB > 0 ? avgR / avgB : 1.0;

	// 饱和度: 像素 RGB 标准差归一化
	let sumSaturation = 0;
	for (let i = 0; i < data.length; i += channels) {
		const r = data[i],
			g = data[i + 1],
			b = data[i + 2];
		const mean = (r + g + b) / 3;
		const variance = ((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3;
		sumSaturation += Math.sqrt(variance) / 255; // 归一化到 0-1
	}

	return {
		luminance: Math.round(avgLuminance * 10) / 10,
		colorTempRatio: Math.round(colorTempRatio * 100) / 100,
		saturation: Math.round((sumSaturation / pixelCount) * 1000) / 1000,
	};
}

/** 维度 → 量化指标提取 (Issue 004) */
export function getDimensionMetric(
	dimension: string,
	comparison: QuantitativeComparison,
): { refValue: number; curValue: number; delta: string } | null {
	switch (dimension) {
		case "brightness":
			return {
				refValue: comparison.reference.luminance,
				curValue: comparison.current.luminance,
				delta: `${comparison.luminanceDelta > 0 ? "+" : ""}${comparison.luminanceDelta.toFixed(1)}%`,
			};
		case "color_temperature":
			return {
				refValue: comparison.reference.colorTempRatio,
				curValue: comparison.current.colorTempRatio,
				delta: `${comparison.colorTempRatioDelta > 0 ? "+" : ""}${comparison.colorTempRatioDelta.toFixed(2)}`,
			};
		case "saturation":
			return {
				refValue: comparison.reference.saturation,
				curValue: comparison.current.saturation,
				delta: `${comparison.saturationDelta > 0 ? "+" : ""}${comparison.saturationDelta.toFixed(3)}`,
			};
		default:
			return null;
	}
}

/** 直方图相关性 (0-1) */
async function computeHistogramCorrelation(buf1: Buffer, buf2: Buffer): Promise<number> {
	// 简化版: 对缩小到 64x64 的两张图做像素相关
	const [pixels1, pixels2] = await Promise.all([
		sharp(buf1).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer(),
		sharp(buf2).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer(),
	]);

	let sumXY = 0,
		sumX = 0,
		sumY = 0,
		sumX2 = 0,
		sumY2 = 0;
	const n = pixels1.length;

	for (let i = 0; i < n; i++) {
		const x = pixels1[i];
		const y = pixels2[i];
		sumXY += x * y;
		sumX += x;
		sumY += y;
		sumX2 += x * x;
		sumY2 += y * y;
	}

	const numerator = n * sumXY - sumX * sumY;
	const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

	if (denominator === 0) return 1;
	const r = numerator / denominator;
	// Pearson 相关系数映射到 0-1 (负相关 → 0)
	return Math.round(Math.max(0, r) * 100) / 100;
}
