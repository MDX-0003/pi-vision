/**
 * Issue 009a — Metrics unit tests
 *
 * Validates color space conversions, histogram helpers, and computeMetrics output shape.
 * Run: npx tsx test/metrics-009a.test.ts
 */

import sharp from "sharp";
import {
	computeLuminance,
	jsd,
	linearizeSRGB,
	mean,
	median,
	pearson,
	percentile,
	srgbToHsv,
	srgbToLab,
	srgbToXyz,
	xyzToLab,
} from "../src/vision/color-utils.ts";
import { computeMetrics, computeImageStats } from "../src/vision/metrics.ts";

// ── Test harness ──

const PASS = "✅";
const FAIL = "❌";
let passed = 0, failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) {
		console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

function approx(a: number, b: number, tol = 0.01): boolean {
	return Math.abs(a - b) < tol;
}

// ── Synthetic image helpers ──

/** Generate a solid-color PNG buffer (1024×768) for testing */
async function solidColorPng(r: number, g: number, b: number): Promise<Buffer> {
	const w = 1024, h = 768;
	const data = Buffer.alloc(w * h * 3);
	for (let i = 0; i < w * h; i++) {
		data[i * 3] = r;
		data[i * 3 + 1] = g;
		data[i * 3 + 2] = b;
	}
	return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ════════════════════════════════════════════
// Section 1: Color space conversions
// ════════════════════════════════════════════

console.log("\n── 1. sRGB Linearization ──");
{
	check("1.1 black → 0", approx(linearizeSRGB(0), 0));
	check("1.2 white (1.0) → 1.0", approx(linearizeSRGB(1), 1));
	// 0.5 → ~0.214 (gamma 2.2-ish midpoint)
	const linearMid = linearizeSRGB(0.5);
	check("1.3 mid-gray in range", linearMid > 0.2 && linearMid < 0.22, `value=${linearMid.toFixed(4)}`);
	// Threshold: 0.04045 → ~0.00313 linear
	const thresh = linearizeSRGB(0.04045);
	check("1.4 threshold value", approx(thresh, 0.00313, 0.001));
}

console.log("\n── 2. sRGB → XYZ ──");
{
	// Pure white
	const w = srgbToXyz(1, 1, 1);
	check("2.1 white X≈D65", approx(w.x, 0.95047, 0.01), `X=${w.x.toFixed(4)}`);
	check("2.2 white Y≈1.0", approx(w.y, 1.0, 0.01), `Y=${w.y.toFixed(4)}`);

	// Pure black
	const bk = srgbToXyz(0, 0, 0);
	check("2.3 black XYZ≈0", approx(bk.x, 0) && approx(bk.y, 0));
}

console.log("\n── 3. XYZ → CIELAB ──");
{
	// D65 white
	const white = xyzToLab(0.95047, 1.0, 1.08883);
	check("3.1 D65 white L≈100", approx(white.l, 100, 0.5), `L=${white.l.toFixed(2)}`);
	check("3.2 D65 white a*≈0", approx(white.a, 0, 0.5), `a=${white.a.toFixed(2)}`);
	check("3.3 D65 white b*≈0", approx(white.b, 0, 0.5), `b=${white.b.toFixed(2)}`);

	// Black
	const black = xyzToLab(0, 0, 0);
	check("3.4 black L≈0", approx(black.l, 0, 1), `L=${black.l.toFixed(2)}`);
}

console.log("\n── 4. sRGB → CIELAB (full pipeline) ──");
{
	// Pure red
	const red = srgbToLab(1, 0, 0);
	check("4.1 red L in range", red.l > 45 && red.l < 60, `L=${red.l.toFixed(2)}`);
	check("4.2 red a* positive (reddish)", red.a > 60, `a*=${red.a.toFixed(2)}`);

	// Pure green
	const green = srgbToLab(0, 1, 0);
	check("4.3 green a* negative (greenish)", green.a < -50, `a*=${green.a.toFixed(2)}`);

	// Pure blue
	const blue = srgbToLab(0, 0, 1);
	check("4.4 blue b* negative (bluish)", blue.b < -50, `b*=${blue.b.toFixed(2)}`);
}

console.log("\n── 5. sRGB → HSV ──");
{
	// Pure red: H=0°, S=1, V=1
	const red = srgbToHsv(1, 0, 0);
	check("5.1 red H≈0", approx(red.h, 0), `H=${red.h.toFixed(3)}`);
	check("5.2 red S=1", approx(red.s, 1), `S=${red.s.toFixed(3)}`);
	check("5.3 red V=1", approx(red.v, 1), `V=${red.v.toFixed(3)}`);

	// Pure green: H=120°=0.333
	const green = srgbToHsv(0, 1, 0);
	check("5.4 green H≈0.333", approx(green.h, 0.333, 0.01), `H=${green.h.toFixed(3)}`);

	// Pure blue: H=240°=0.667
	const blue = srgbToHsv(0, 0, 1);
	check("5.5 blue H≈0.667", approx(blue.h, 0.667, 0.01), `H=${blue.h.toFixed(3)}`);

	// White: S=0
	const white = srgbToHsv(1, 1, 1);
	check("5.6 white S=0", approx(white.s, 0));

	// Black: V=0
	const black = srgbToHsv(0, 0, 0);
	check("5.7 black V=0", approx(black.v, 0));

	// JS % fix: Python `(-0.5) % 6 = 5.5`, h/=6 = 0.9167
	// Cyan (0,1,1): max=G, diff=B-R=1-0=1, h=(1+2)/6=0.5
	const cyan = srgbToHsv(0, 1, 1);
	check("5.8 cyan H≈0.5", approx(cyan.h, 0.5, 0.01), `H=${cyan.h.toFixed(3)}`);

	// Magenta (1,0,1): max=R=B=1, diff=B-R=0 ok, or max=R→(0-1)/diff=-1%6=5/6=0.833
	const magenta = srgbToHsv(1, 0, 1);
	const expectedMH = 5 / 6; // 0.833
	check("5.9 magenta H≈0.833", approx(magenta.h, expectedMH, 0.01), `H=${magenta.h.toFixed(3)}`);
}

console.log("\n── 6. Histogram Utilities ──");
{
	const a = new Float64Array([0.1, 0.2, 0.3, 0.4]);
	const b = new Float64Array([0.1, 0.2, 0.3, 0.4]);

	// JSD: identical distributions → 0
	check("6.1 JSD identical = 0", approx(jsd(a, b), 0, 0.0001), `JSD=${jsd(a, b).toFixed(6)}`);

	// Pearson: identical → 1
	check("6.2 Pearson identical = 1", approx(pearson(a, b), 1, 0.0001), `r=${pearson(a, b).toFixed(6)}`);

	// Pearson: inverse → -1
	const c = new Float64Array([0.4, 0.3, 0.2, 0.1]);
	check("6.3 Pearson inverse = -1", approx(pearson(a, c), -1, 0.0001), `r=${pearson(a, c).toFixed(6)}`);

	// Mean
	check("6.4 mean", approx(mean(new Float64Array([1, 2, 3, 4, 5])), 3));

	// Median (odd)
	const odd = new Float64Array([1, 5, 3, 2, 4]);
	check("6.5 median odd", approx(median(odd), 3));

	// Median (even)
	const even = new Float64Array([1, 4, 2, 3]);
	check("6.6 median even", approx(median(even), 2.5));
}

console.log("\n── 7. Luminance ──");
{
	// White
	check("7.1 white luminance", approx(computeLuminance(1, 1, 1), 1));
	// Black
	check("7.2 black luminance", approx(computeLuminance(0, 0, 0), 0));
	// Green is brightest per BT.601
	check("7.3 green > red", computeLuminance(0, 1, 0) > computeLuminance(1, 0, 0));
}

// ════════════════════════════════════════════
// Section 8: computeMetrics output
// ════════════════════════════════════════════

console.log("\n── 8. computeMetrics (synthetic images) ──");

async function testComputeMetrics(): Promise<void> {
	// Identical images
	const whitePng = await solidColorPng(255, 255, 255);
	const metrics = await computeMetrics(whitePng, whitePng);

	check("8.1 luminance — identical → deltaPct≈0", approx(metrics.luminance.deltaPct, 0, 0.1),
		`delta=${metrics.luminance.deltaPct}%`);

	check("8.2 deltaE.mean — identical → 0", approx(metrics.deltaE.mean, 0, 0.5),
		`mean=${metrics.deltaE.mean}`);

	check("8.3 deltaE.p90 — identical → 0", approx(metrics.deltaE.p90, 0, 0.5),
		`p90=${metrics.deltaE.p90}`);

	check("8.4 hueJSD — identical → 0", approx(metrics.hueJSD, 0, 0.001),
		`JSD=${metrics.hueJSD}`);

	check("8.5 gradientCorrelation — identical → 1 (flat image = perfectly matched gradients)",
		approx(metrics.gradientCorrelation, 1, 0.001),
		`corr=${metrics.gradientCorrelation}`);

	check("8.6 histogramCorrelation — identical → 1", approx(metrics.histogramCorrelation, 1, 0.001),
		`corr=${metrics.histogramCorrelation}`);

	check("8.7 tonalRB.directionFlipped = false", metrics.tonalRB.directionFlipped === false);

	check("8.8 perChannel.r has ref and cur", !!metrics.perChannel.r.ref && !!metrics.perChannel.r.cur);

	check("8.9 regional.sky has rbRatio", !!metrics.regional.sky.rbRatio.ref);

	check("8.10 zoneBalance in range", metrics.zoneBalance >= -1 && metrics.zoneBalance <= 1,
		`val=${metrics.zoneBalance}`);
}

await testComputeMetrics();

// Different images
console.log("\n── 9. computeMetrics (different images) ──");
{
	const white = await solidColorPng(255, 255, 255);
	const black = await solidColorPng(0, 0, 0);
	const diff = await computeMetrics(white, black);

	check("9.1 black/white — luminance delta negative (cur<ref)",
		diff.luminance.deltaPct < -50, `delta=${diff.luminance.deltaPct}%`);

	check("9.2 black/white — deltaE.mean > 50", diff.deltaE.mean > 50,
		`mean=${diff.deltaE.mean}`);

	check("9.3 perChannel values differ",
		diff.perChannel.r.ref.mean > diff.perChannel.r.cur.mean,
		`R ref=${diff.perChannel.r.ref.mean} cur=${diff.perChannel.r.cur.mean}`);
}

// Legacy exports
console.log("\n── 10. Legacy exports ──");
{
	const white = await solidColorPng(255, 255, 255);
	const black = await solidColorPng(0, 0, 0);
	const stats = await computeImageStats(white);
	check("10.1 computeImageStats white — luminance>0", stats.luminance > 200);
	check("10.2 computeImageStats white — saturation≈0", approx(stats.saturation, 0, 0.05),
		`sat=${stats.saturation}`);
}

// ════════════════════════════════════════════
console.log(`\n${"=".repeat(50)}`);
console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
console.log(`${"=".repeat(50)}`);

if (failed > 0) process.exit(1);
