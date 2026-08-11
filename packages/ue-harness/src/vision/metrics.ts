/**
 * Issue 009a — Quantitative Metrics (12 metrics)
 *
 * Rewrite of Issue 003 metrics.ts. Image comparison metrics for Vision prompt injection.
 * All computation on 1024px-sharp-resized images, <20ms target.
 *
 * Algorithm references:
 *   E:/Programs/UE_Project_58/MCP/Test/compare_images.py
 *   E:/Programs/UE_Project_58/MCP/Test/compare_atmosphere.py
 *   E:/Programs/UE_Project_58/MCP/Test/test_structural_metrics.py
 *   E:/Programs/UE_Project_58/MCP/Test/validate_metrics.py
 */

import sharp from "sharp";
import {
	computeLuminance,
	histogram,
	jsd,
	mean,
	median,
	pearson,
	percentile,
	srgbToHsv,
	srgbToLab,
} from "./color-utils.ts";

// ── Types ──

interface ChannelStat {
	mean: number;
	std: number;
}

interface TonalRBEntry {
	refRB: number;
	curRB: number;
	diff: number;
}

interface TonalRBResult {
	shadow: TonalRBEntry;
	midtone: TonalRBEntry;
	highlight: TonalRBEntry;
	/** true when shadow and highlight R/B diffs go in opposite directions → PostProcess signal */
	directionFlipped: boolean;
}

interface DeltaEResult {
	mean: number;
	median: number;
	p90: number;
}

interface RegionStats {
	rbRatio: { ref: number; cur: number };
	luminance: { ref: number; cur: number };
	saturation: { ref: number; cur: number };
}

interface RegionalResult {
	sky: RegionStats;
	horizon: RegionStats;
	ground: RegionStats;
}

export interface QuantitativeReport {
	/** Weighted luminance mean (BT.601) + delta % */
	luminance: { ref: number; cur: number; deltaPct: number };

	/** Per-channel (R/G/B) mean and std */
	perChannel: {
		r: { ref: ChannelStat; cur: ChannelStat };
		g: { ref: ChannelStat; cur: ChannelStat };
		b: { ref: ChannelStat; cur: ChannelStat };
	};

	/** Shadow / Midtone / Highlight R/B ratio with PostProcess directionFlipped signal */
	tonalRB: TonalRBResult;

	/** CIEDE76 perceptual color difference */
	deltaE: DeltaEResult;

	/** CIELAB chroma mean (sqrt(a*²+b*²)) */
	chroma: { ref: number; cur: number; diff: number };

	/** 12-bin HSV hue histogram Jensen-Shannon divergence */
	hueJSD: number;

	/** Per-region (sky / horizon / ground) R/B, luminance, saturation */
	regional: RegionalResult;

	/** Vertical luminance gradient Pearson correlation */
	gradientCorrelation: number;

	/** 11-zone luminance histogram correlation (Ansel Adams Zone System) */
	zoneBalance: number;

	/** 64×64 grayscale histogram Pearson correlation (preserved from Issue 003) */
	histogramCorrelation: number;
}

// ── Internal pixel buffer ──

interface RawPixels {
	data: Uint8Array;
	width: number;
	height: number;
	channels: number; // 3 or 4
}

async function getRawPixels(buffer: Buffer): Promise<RawPixels> {
	const { data, info } = await sharp(buffer)
		.resize(1024, 1024, { fit: "inside" })
		.raw()
		.toBuffer({ resolveWithObject: true });

	return {
		data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		width: info.width,
		height: info.height,
		channels: info.channels,
	};
}

function cropMatch(a: RawPixels, b: RawPixels): [RawPixels, RawPixels] {
	const w = Math.min(a.width, b.width);
	const h = Math.min(a.height, b.height);
	if (w === a.width && h === a.height && w === b.width && h === b.height) return [a, b];

	// Crop both to same dimensions (top-left aligned)
	function crop(p: RawPixels): RawPixels {
		if (p.width === w && p.height === h) return p;
		const stride = p.channels;
		const newData = new Uint8Array(w * h * stride);
		for (let y = 0; y < h; y++) {
			const srcOff = y * p.width * stride;
			const dstOff = y * w * stride;
			for (let x = 0; x < w * stride; x++) {
				newData[dstOff + x] = p.data[srcOff + x];
			}
		}
		return { data: newData, width: w, height: h, channels: stride };
	}

	return [crop(a), crop(b)];
}

// ── Per-pixel data (computed once, reused across metrics) ──

interface PixelChannels {
	/** 0-1 */
	r: number;
	g: number;
	b: number;
}

function getPixel(raw: RawPixels, idx: number): PixelChannels {
	const ch = raw.channels;
	const off = idx * ch;
	return {
		r: raw.data[off] / 255,
		g: raw.data[off + 1] / 255,
		b: raw.data[off + 2] / 255,
	};
}

// ── Per-image summary (streaming — minimal allocation) ──

interface ImageSummary {
	width: number;
	height: number;
	pixelCount: number;

	/** Luminance mean (BT.601, 0-1) */
	luminanceMean: number;

	/** HSV Saturation mean (0-1) */
	saturationMean: number;

	/** Per-channel mean & std */
	r: ChannelStat;
	g: ChannelStat;
	b: ChannelStat;

	/** Tonal R/B: shadow/midtone/highlight R sums, B sums, counts */
	tonalCounts: [number, number, number, number, number, number, number, number, number];
	// [sRsum, sBsum, sCnt, mRsum, mBsum, mCnt, hRsum, hBsum, hCnt]

	/** Chroma sum (for mean) */
	chromaSum: number;

	/** 12-bin hue histogram (normalized) */
	hueHist: Float64Array;

	/** Per-row luminance (for gradient correlation), length = height */
	rowLuminance: Float64Array;

	/** 11-zone luminance histogram (normalized) */
	zoneHist: Float64Array;

	// ── Per-pixel arrays for cross-image Delta E ──
	labL: Float64Array;
	labA: Float64Array;
	labB: Float64Array;

	// ── Regional aggregates ──
	skyRB: [number, number, number]; // [Rsum, Bsum, count]
	skyLum: [number, number];        // [sum, count]
	skySat: [number, number];        // [sum, count]
	horizonRB: [number, number, number];
	horizonLum: [number, number];
	horizonSat: [number, number];
	groundRB: [number, number, number];
	groundLum: [number, number];
	groundSat: [number, number];
}

// ── Classification helpers ──

type Region = "sky" | "horizon" | "ground";

function classifyRegion(y: number, height: number): Region {
	const skyEnd = Math.floor(height / 3);
	const groundStart = Math.floor((height * 2) / 3);
	if (y < skyEnd) return "sky";
	if (y < groundStart) return "horizon";
	return "ground";
}

type TonalBand = "shadow" | "midtone" | "highlight";

function classifyTonalBand(luminance: number): TonalBand | null {
	if (luminance < 0 || luminance >= 1) return null;
	if (luminance < 0.33) return "shadow";
	if (luminance < 0.66) return "midtone";
	return "highlight";
}

// ── Main per-image summary computation ──

function computeImageSummary(raw: RawPixels): ImageSummary {
	const { width, height } = raw;
	const pixelCount = width * height;

	// Initialize accumulators
	let lumSum = 0;
	let satSum = 0;
	let rSum = 0, gSum = 0, bSum = 0;
	let rSqSum = 0, gSqSum = 0, bSqSum = 0;

	// Tonal band accumulators: [Rsum, Bsum, count] × 3
	let sR = 0, sB = 0, sC = 0;
	let mR = 0, mB = 0, mC = 0;
	let hR = 0, hB = 0, hC = 0;

	let chromaSum = 0;

	// Hue histogram (12 bins × 30°, 0-1 range)
	const hueBins = new Float64Array(12);

	// Row luminance
	const rowLuminance = new Float64Array(height);

	// Zone histogram (11 zones)
	const zoneBins = new Float64Array(11);

	// Regional accumulators
	let skyR = 0, skyB = 0, skyC = 0, skyL = 0, skySat = 0;
	let hzR = 0, hzB = 0, hzC = 0, hzL = 0, hzSat = 0;
	let gndR = 0, gndB = 0, gndC = 0, gndL = 0, gndSat = 0;

	// Per-pixel Lab arrays
	const labL = new Float64Array(pixelCount);
	const labA = new Float64Array(pixelCount);
	const labB = new Float64Array(pixelCount);

	for (let y = 0; y < height; y++) {
		let rowLum = 0;
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			const p = getPixel(raw, idx);

			// Luminance
			const lum = computeLuminance(p.r, p.g, p.b);
			lumSum += lum;
			rowLum += lum;

			// Per-channel
			rSum += p.r; rSqSum += p.r * p.r;
			gSum += p.g; gSqSum += p.g * p.g;
			bSum += p.b; bSqSum += p.b * p.b;

			// HSV
			const hsv = srgbToHsv(p.r, p.g, p.b);
			satSum += hsv.s;

			// Hue histogram
			const hueBin = Math.min(11, Math.floor(hsv.h * 12));
			hueBins[hueBin]++;

			// CIELAB
			const lab = srgbToLab(p.r, p.g, p.b);
			labL[idx] = lab.l;
			labA[idx] = lab.a;
			labB[idx] = lab.b;
			chromaSum += Math.sqrt(lab.a * lab.a + lab.b * lab.b);

			// Tonal band
			const band = classifyTonalBand(lum);
			if (band === "shadow")      { sR += p.r; sB += p.b; sC++; }
			else if (band === "midtone") { mR += p.r; mB += p.b; mC++; }
			else if (band === "highlight") { hR += p.r; hB += p.b; hC++; }

			// Zone histogram
			const zone = Math.min(10, Math.max(0, Math.floor(lum * 11)));
			zoneBins[zone]++;

			// Regional
			const region = classifyRegion(y, height);
			if (region === "sky") {
				skyR += p.r; skyB += p.b; skyC++;
				skyL += lum; skySat += hsv.s;
			} else if (region === "horizon") {
				hzR += p.r; hzB += p.b; hzC++;
				hzL += lum; hzSat += hsv.s;
			} else {
				gndR += p.r; gndB += p.b; gndC++;
				gndL += lum; gndSat += hsv.s;
			}
		}
		rowLuminance[y] = rowLum / width;
	}

	// Normalize histograms
	const invPx = 1 / pixelCount;
	for (let i = 0; i < 12; i++) hueBins[i] *= invPx;
	for (let i = 0; i < 11; i++) zoneBins[i] *= invPx;

	return {
		width, height, pixelCount,
		luminanceMean: lumSum * invPx,
		saturationMean: satSum * invPx,
		r: { mean: rSum * invPx, std: Math.sqrt(Math.max(0, rSqSum * invPx - (rSum * invPx) ** 2)) },
		g: { mean: gSum * invPx, std: Math.sqrt(Math.max(0, gSqSum * invPx - (gSum * invPx) ** 2)) },
		b: { mean: bSum * invPx, std: Math.sqrt(Math.max(0, bSqSum * invPx - (bSum * invPx) ** 2)) },
		tonalCounts: [sR, sB, sC, mR, mB, mC, hR, hB, hC],
		chromaSum,
		hueHist: hueBins,
		rowLuminance,
		zoneHist: zoneBins,
		labL, labA, labB,
		skyRB: [skyR, skyB, skyC], skyLum: [skyL, skyC], skySat: [skySat, skyC],
		horizonRB: [hzR, hzB, hzC], horizonLum: [hzL, hzC], horizonSat: [hzSat, hzC],
		groundRB: [gndR, gndB, gndC], groundLum: [gndL, gndC], groundSat: [gndSat, gndC],
	};
}

// ── Derived metric functions ──

function rbRatio(rSum: number, bSum: number, count: number): number {
	if (count === 0 || bSum === 0) return 0;
	return (rSum / count) / (bSum / count);
}

function computeTonalRB(ref: ImageSummary, cur: ImageSummary): TonalRBResult {
	const [srR, srB, srC, mR, mB, mC, hrR, hrB, hrC] = ref.tonalCounts;
	const [scR, scB, scC, mcR, mcB, mcC, hcR, hcB, hcC] = cur.tonalCounts;

	const shadow: TonalRBEntry = {
		refRB: rbRatio(srR, srB, srC),
		curRB: rbRatio(scR, scB, scC),
		diff: rbRatio(scR, scB, scC) - rbRatio(srR, srB, srC),
	};
	const midtone: TonalRBEntry = {
		refRB: rbRatio(mR, mB, mC),
		curRB: rbRatio(mcR, mcB, mcC),
		diff: rbRatio(mcR, mcB, mcC) - rbRatio(mR, mB, mC),
	};
	const highlight: TonalRBEntry = {
		refRB: rbRatio(hrR, hrB, hrC),
		curRB: rbRatio(hcR, hcB, hcC),
		diff: rbRatio(hcR, hcB, hcC) - rbRatio(hrR, hrB, hrC),
	};

	// directionFlipped: shadow & highlight move in opposite directions (>0.05 threshold)
	const directionFlipped =
		(shadow.diff > 0.05 && highlight.diff < -0.05) ||
		(shadow.diff < -0.05 && highlight.diff > 0.05);

	return { shadow, midtone, highlight, directionFlipped };
}

function computeDeltaE(ref: ImageSummary, cur: ImageSummary): DeltaEResult {
	const n = Math.min(ref.pixelCount, cur.pixelCount);
	const deArr = new Float64Array(n);

	for (let i = 0; i < n; i++) {
		const dL = ref.labL[i] - cur.labL[i];
		const da = ref.labA[i] - cur.labA[i];
		const db = ref.labB[i] - cur.labB[i];
		deArr[i] = Math.sqrt(dL * dL + da * da + db * db);
	}

	return {
		mean: mean(deArr),
		median: median(deArr),
		p90: percentile(deArr, 90),
	};
}

function computeRegional(ref: ImageSummary, cur: ImageSummary): RegionalResult {
	function extract(rb: [number, number, number], lum: [number, number], sat: [number, number]): Omit<RegionStats, ""> {
		return {
			rbRatio: rb[2] > 0 ? (rb[0] / rb[2]) / (rb[1] / rb[2]) : 0,
			luminance: lum[1] > 0 ? lum[0] / lum[1] : 0,
			saturation: sat[1] > 0 ? sat[0] / sat[1] : 0,
		};
	}

	function compare(
		rRB: [number, number, number], rLum: [number, number], rSat: [number, number],
		cRB: [number, number, number], cLum: [number, number], cSat: [number, number],
	): RegionStats {
		const refData = extract(rRB, rLum, rSat);
		const curData = extract(cRB, cLum, cSat);
		return {
			rbRatio: { ref: refData.rbRatio, cur: curData.rbRatio },
			luminance: { ref: refData.luminance, cur: curData.luminance },
			saturation: { ref: refData.saturation, cur: curData.saturation },
		};
	}

	return {
		sky: compare(ref.skyRB, ref.skyLum, ref.skySat, cur.skyRB, cur.skyLum, cur.skySat),
		horizon: compare(ref.horizonRB, ref.horizonLum, ref.horizonSat, cur.horizonRB, cur.horizonLum, cur.horizonSat),
		ground: compare(ref.groundRB, ref.groundLum, ref.groundSat, cur.groundRB, cur.groundLum, cur.groundSat),
	};
}

function computeGradientCorrelation(ref: ImageSummary, cur: ImageSummary): number {
	const minH = Math.min(ref.height, cur.height);
	const refGrad = new Float64Array(minH - 1);
	const curGrad = new Float64Array(minH - 1);
	let refHasGrad = false, curHasGrad = false;
	for (let i = 0; i < minH - 1; i++) {
		refGrad[i] = ref.rowLuminance[i + 1] - ref.rowLuminance[i];
		curGrad[i] = cur.rowLuminance[i + 1] - cur.rowLuminance[i];
		if (Math.abs(refGrad[i]) > 1e-10) refHasGrad = true;
		if (Math.abs(curGrad[i]) > 1e-10) curHasGrad = true;
	}
	// Both flat → identical gradients → perfect correlation
	if (!refHasGrad && !curHasGrad) return 1;
	// One flat, one not → no correlation
	if (!refHasGrad || !curHasGrad) return 0;
	const corr = pearson(refGrad, curGrad);
	return isNaN(corr) ? 0 : corr;
}

// ── Preserved: 64×64 histogram correlation (Issue 003) ──

async function computeHistogramCorrelation(buf1: Buffer, buf2: Buffer): Promise<number> {
	const [pixels1, pixels2] = await Promise.all([
		sharp(buf1).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer(),
		sharp(buf2).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer(),
	]);

	let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
	const n = pixels1.length;

	for (let i = 0; i < n; i++) {
		const x = pixels1[i], y = pixels2[i];
		sumXY += x * y;
		sumX += x;
		sumY += y;
		sumX2 += x * x;
		sumY2 += y * y;
	}

	const numerator = n * sumXY - sumX * sumY;
	const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
	if (denominator === 0) return 1;
	return Math.max(0, numerator / denominator);
}

// ── Main entry ──

export async function computeMetrics(refBuffer: Buffer, curBuffer: Buffer): Promise<QuantitativeReport> {
	const [refRaw, curRaw] = await Promise.all([
		getRawPixels(refBuffer),
		getRawPixels(curBuffer),
	]);

	const [ref, cur] = cropMatch(refRaw, curRaw);

	// Per-image summaries (could be parallel but both <10ms, not worth it)
	const refSummary = computeImageSummary(ref);
	const curSummary = computeImageSummary(cur);

	// Cross-image metrics
	const deltaE = computeDeltaE(refSummary, curSummary);
	const gradientCorrelation = computeGradientCorrelation(refSummary, curSummary);
	const zoneBalance = pearson(refSummary.zoneHist, curSummary.zoneHist);
	const hueJSD = jsd(refSummary.hueHist, curSummary.hueHist);
	const histogramCorrelation = await computeHistogramCorrelation(refBuffer, curBuffer);

	// Tonal RB
	const tonalRB = computeTonalRB(refSummary, curSummary);

	// Regional
	const regional = computeRegional(refSummary, curSummary);

	return {
		luminance: {
			ref: round(refSummary.luminanceMean * 255, 1),
			cur: round(curSummary.luminanceMean * 255, 1),
			deltaPct: refSummary.luminanceMean > 0
				? round(((curSummary.luminanceMean - refSummary.luminanceMean) / refSummary.luminanceMean) * 100, 1)
				: 0,
		},
		perChannel: {
			r: {
				ref: { mean: round(refSummary.r.mean, 4), std: round(refSummary.r.std, 4) },
				cur: { mean: round(curSummary.r.mean, 4), std: round(curSummary.r.std, 4) },
			},
			g: {
				ref: { mean: round(refSummary.g.mean, 4), std: round(refSummary.g.std, 4) },
				cur: { mean: round(curSummary.g.mean, 4), std: round(curSummary.g.std, 4) },
			},
			b: {
				ref: { mean: round(refSummary.b.mean, 4), std: round(refSummary.b.std, 4) },
				cur: { mean: round(curSummary.b.mean, 4), std: round(curSummary.b.std, 4) },
			},
		},
		tonalRB: {
			shadow:      { refRB: round(tonalRB.shadow.refRB, 4), curRB: round(tonalRB.shadow.curRB, 4), diff: round(tonalRB.shadow.diff, 4) },
			midtone:     { refRB: round(tonalRB.midtone.refRB, 4), curRB: round(tonalRB.midtone.curRB, 4), diff: round(tonalRB.midtone.diff, 4) },
			highlight:   { refRB: round(tonalRB.highlight.refRB, 4), curRB: round(tonalRB.highlight.curRB, 4), diff: round(tonalRB.highlight.diff, 4) },
			directionFlipped: tonalRB.directionFlipped,
		},
		deltaE: {
			mean: round(deltaE.mean, 2),
			median: round(deltaE.median, 2),
			p90: round(deltaE.p90, 2),
		},
		chroma: {
			ref: round(refSummary.chromaSum / refSummary.pixelCount, 2),
			cur: round(curSummary.chromaSum / curSummary.pixelCount, 2),
			diff: round((curSummary.chromaSum / curSummary.pixelCount) - (refSummary.chromaSum / refSummary.pixelCount), 2),
		},
		hueJSD: round(hueJSD, 6),
		regional: {
			sky: {
				rbRatio: { ref: round(regional.sky.rbRatio.ref, 4), cur: round(regional.sky.rbRatio.cur, 4) },
				luminance: { ref: round(regional.sky.luminance.ref, 4), cur: round(regional.sky.luminance.cur, 4) },
				saturation: { ref: round(regional.sky.saturation.ref, 4), cur: round(regional.sky.saturation.cur, 4) },
			},
			horizon: {
				rbRatio: { ref: round(regional.horizon.rbRatio.ref, 4), cur: round(regional.horizon.rbRatio.cur, 4) },
				luminance: { ref: round(regional.horizon.luminance.ref, 4), cur: round(regional.horizon.luminance.cur, 4) },
				saturation: { ref: round(regional.horizon.saturation.ref, 4), cur: round(regional.horizon.saturation.cur, 4) },
			},
			ground: {
				rbRatio: { ref: round(regional.ground.rbRatio.ref, 4), cur: round(regional.ground.rbRatio.cur, 4) },
				luminance: { ref: round(regional.ground.luminance.ref, 4), cur: round(regional.ground.luminance.cur, 4) },
				saturation: { ref: round(regional.ground.saturation.ref, 4), cur: round(regional.ground.saturation.cur, 4) },
			},
		},
		gradientCorrelation: round(gradientCorrelation, 6),
		zoneBalance: round(isNaN(zoneBalance) ? 0 : zoneBalance, 6),
		histogramCorrelation: round(histogramCorrelation, 2),
	};
}

function round(v: number, d: number): number {
	const m = 10 ** d;
	return Math.round(v * m) / m;
}

// Preserve legacy exports for dependent code (Issue 003 types)
export interface ImageStats {
	luminance: number;
	colorTempRatio: number;
	saturation: number;
}

export interface QuantitativeComparison {
	reference: ImageStats;
	current: ImageStats;
	luminanceDelta: number;
	colorTempRatioDelta: number;
	saturationDelta: number;
	histogramCorrelation: number;
}

/** @deprecated Use computeMetrics() → QuantitativeReport instead */
export async function computeImageStats(buffer: Buffer): Promise<ImageStats> {
	const raw = await getRawPixels(buffer);
	const summary = computeImageSummary(raw);
	return {
		luminance: summary.luminanceMean * 255,
		colorTempRatio: summary.r.mean / (summary.b.mean + 1e-10),
		saturation: summary.saturationMean,
	};
}

/** @deprecated Use computeMetrics() → QuantitativeReport instead */
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
