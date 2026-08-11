/**
 * Issue 009a — Color Space Conversion Utilities
 *
 * Pure functions for RGB ↔ CIELAB / HSV conversion, histogram helpers.
 * Algorithm constants matched to Python reference scripts:
 *   E:/Programs/UE_Project_58/MCP/Test/compare_images.py
 *   E:/Programs/UE_Project_58/MCP/Test/compare_atmosphere.py
 *   E:/Programs/UE_Project_58/MCP/Test/validate_metrics.py
 */

// ── Per-pixel conversion constants ──

/** sRGB linearization threshold (IEC 61966-2-1) */
const SRGB_THRESHOLD = 0.04045;

/** D65 white point — XYZ normalization */
const D65_X = 0.95047;
const D65_Y = 1.0;
const D65_Z = 1.08883;

/** CIE Lab conversion */
const LAB_EPS = 0.008856;
const LAB_KAPPA = 903.3;

/** D65 sRGB→XYZ matrix (row-major) */
const M00 = 0.4124564, M01 = 0.3575761, M02 = 0.1804375;
const M10 = 0.2126729, M11 = 0.7151522, M12 = 0.0721750;
const M20 = 0.0193339, M21 = 0.1191920, M22 = 0.9503041;

/** Perceptual luminance weights (BT.601 / Rec. 601) */
const LUM_R = 0.299, LUM_G = 0.587, LUM_B = 0.114;

// ── Pixel-level conversions (no allocation — call in tight loops) ──

/** sRGB single-channel linearization */
export function linearizeSRGB(c: number): number {
	return c > SRGB_THRESHOLD ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
}

/**
 * sRGB (0-1) → CIE XYZ (D65).
 * Returns { x, y, z } unnormalized (caller divides by D65 white point).
 */
export function srgbToXyz(r: number, g: number, b: number): { x: number; y: number; z: number } {
	const rl = linearizeSRGB(r);
	const gl = linearizeSRGB(g);
	const bl = linearizeSRGB(b);
	return {
		x: rl * M00 + gl * M01 + bl * M02,
		y: rl * M10 + gl * M11 + bl * M12,
		z: rl * M20 + gl * M21 + bl * M22,
	};
}

/** CIE XYZ (normalized to D65) → CIELAB */
export function xyzToLab(x: number, y: number, z: number): { l: number; a: number; b: number } {
	const xn = x / D65_X;
	const yn = y / D65_Y;
	const zn = z / D65_Z;

	const fx = xn > LAB_EPS ? xn ** (1 / 3) : (LAB_KAPPA * xn + 16) / 116;
	const fy = yn > LAB_EPS ? yn ** (1 / 3) : (LAB_KAPPA * yn + 16) / 116;
	const fz = zn > LAB_EPS ? zn ** (1 / 3) : (LAB_KAPPA * zn + 16) / 116;

	return {
		l: 116 * fy - 16,
		a: 500 * (fx - fy),
		b: 200 * (fy - fz),
	};
}

/** sRGB (0-1) → CIELAB (single call convenience) */
export function srgbToLab(r: number, g: number, b: number): { l: number; a: number; b: number } {
	const xyz = srgbToXyz(r, g, b);
	return xyzToLab(xyz.x, xyz.y, xyz.z);
}

/** sRGB (0-1) → HSV (h/s/v all 0-1) */
export function srgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const v = max;
	const range = max - min;
	const s = max === 0 ? 0 : range / max;

	let h = 0;
	if (range !== 0) {
		if (max === r) {
			// JS % preserves sign, Python % always returns positive → add 6 before modulo
			h = ((g - b) / range + 6) % 6;
		} else if (max === g) {
			h = (b - r) / range + 2;
		} else {
			h = (r - g) / range + 4;
		}
		h /= 6;
	}

	return { h, s, v };
}

/** Perceptual luminance (BT.601, 0-1) */
export function computeLuminance(r: number, g: number, b: number): number {
	return LUM_R * r + LUM_G * g + LUM_B * b;
}

// ── Histogram utilities ──

/**
 * Jensen-Shannon Divergence between two normalized histograms.
 * 0 = identical distributions, higher = more different.
 */
export function jsd(p: Float64Array | number[], q: Float64Array | number[]): number {
	const n = p.length;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const pi = p[i], qi = q[i];
		const m = (pi + qi) / 2;
		if (pi > 1e-15) sum += 0.5 * pi * Math.log(pi / (m + 1e-15));
		if (qi > 1e-15) sum += 0.5 * qi * Math.log(qi / (m + 1e-15));
	}
	return sum;
}

/**
 * Pearson correlation coefficient between two arrays.
 * 1 = perfect positive correlation, -1 = perfect negative, 0 = no correlation.
 */
export function pearson(a: Float64Array | number[], b: Float64Array | number[]): number {
	const n = a.length;
	let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i], y = b[i];
		sumX += x; sumY += y;
		sumXY += x * y;
		sumX2 += x * x; sumY2 += y * y;
	}
	const num = n * sumXY - sumX * sumY;
	const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
	return den === 0 ? 0 : num / den;
}

/**
 * Build a normalized histogram from raw values.
 * @returns normalized histogram (sum=1) and bin edges
 */
export function histogram(values: Float64Array, binCount: number, lo: number, hi: number): Float64Array {
	const h = new Float64Array(binCount);
	const binWidth = (hi - lo) / binCount;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v < lo || v >= hi) continue;
		const idx = Math.min(binCount - 1, Math.floor((v - lo) / binWidth));
		h[idx]++;
	}
	const total = values.length || 1;
	for (let i = 0; i < binCount; i++) h[i] /= total;
	return h;
}

/**
 * Percentile from sorted values (linear interpolation).
 * If unsorted, set sorted=false to auto-sort (mutates input).
 */
export function percentile(sorted: Float64Array, p: number): number {
	if (sorted.length === 0) return 0;
	const idx = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	const frac = idx - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Mean of a typed array */
export function mean(arr: Float64Array): number {
	if (arr.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < arr.length; i++) sum += arr[i];
	return sum / arr.length;
}

/** Median (mutates input: sorts in-place for performance) */
export function median(arr: Float64Array): number {
	if (arr.length === 0) return 0;
	arr.sort();
	const mid = arr.length >> 1;
	return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}
