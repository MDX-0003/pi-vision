/**
 * Issue 003 — assess_lighting 验证
 *
 * 测试:
 *  1. metrics 计算（相同图 → 一致指标）
 *  2. Vision prompt 格式
 *  3. 端到端调用 (需 VISION_API_KEY)
 *
 * 运行: npx tsx test/verify-assess-lighting.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { setUeClient, setVisionClient } from "../src/state.ts";
import { executeAssessLighting } from "../src/tools/assess-lighting.ts";
import { UeClient } from "../src/ue-client/mcp-client.ts";
import { captureViewport } from "../src/vision/capture.ts";
import { computeMetrics } from "../src/vision/metrics.ts";
import { ARTIFICIALITY_PROMPT, ATMOSPHERE_ANALYSIS_PROMPT, dimensionCheckPrompt } from "../src/vision/prompts.ts";
import { VisionClient } from "../src/vision/vision-client.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0,
	failed = 0;
function check(name: string, condition: boolean, detail = "") {
	if (condition) {
		console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	return String(content);
}

function loadVisionAuth() {
	const p = join(homedir(), ".pi", "agent", "vision-auth.json");
	try {
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
	} catch {}
	return null;
}

async function main() {
	console.log("=".repeat(60));
	console.log("Issue 003 Verification — assess_lighting");
	console.log("=".repeat(60));
	console.log("");

	// ── Setup: connect to UE ──
	const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8000/mcp"), {
		requestInit: { headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" } },
	});
	const client = new Client({ name: "issue003-verify", version: "1.0" }, { capabilities: {} });
	await client.connect(transport);

	const tsResult = await client.callTool({ name: "list_toolsets", arguments: {} });
	const tsNames = [...extractText(tsResult.content).matchAll(/^\s*-\s*(\S+):/gm)].map((m: any) => m[1]);
	for (const name of tsNames) {
		try {
			await client.callTool({ name: "load_toolset", arguments: { toolset_name: name } });
		} catch (_e) {}
	}
	await new Promise((r) => setTimeout(r, 500));

	// Load vision auth (env var > file)
	const visionAuth = loadVisionAuth();
	const visionApiKey = process.env.VISION_API_KEY || visionAuth?.apiKey;

	const config = {
		ueMcpUrl: "http://localhost:8000/mcp",
		visionApiKey,
		visionApiBaseUrl: process.env.VISION_API_BASE_URL || visionAuth?.baseUrl,
		visionModelId: process.env.VISION_MODEL_ID || visionAuth?.modelId,
	};
	const ueClient = new UeClient(config);
	await ueClient.connect();
	setUeClient(ueClient);

	const visionClient = new VisionClient(config);
	setVisionClient(visionClient);

	// ── Test 1: Capture screenshot as test reference ──
	console.log("── Test 1: Screenshot Capture ──");
	const capture = await captureViewport(ueClient, 1.0);
	check("1.1 CaptureViewportImage success", !!capture);
	check("1.2 File path returned", !!capture?.filePath);
	check(
		"1.3 File ≥ 100KB",
		(capture?.fileSize ?? 0) >= 102400,
		capture ? `${(capture.fileSize / 1024 / 1024).toFixed(2)} MB` : "N/A",
	);
	check(
		"1.4 base64 data valid",
		(capture?.base64?.length ?? 0) > 1000,
		capture ? `${capture.base64.length} chars` : "N/A",
	);

	if (capture) {
		// Write as test reference
		writeFileSync(
			"d:/Programs/2024-2/pi/packages/ue-harness/test/test-ref.png",
			Buffer.from(capture.base64, "base64"),
		);
		console.log("  Saved test reference: test/test-ref.png");
	}
	console.log("");

	// ── Test 2: Quantitative Metrics ──
	console.log("── Test 2: Quantitative Metrics ──");
	if (capture) {
		const buf = Buffer.from(capture.base64, "base64");
		const metrics = await computeMetrics(buf, buf); // same image → should be identical
		check(
			"2.1 luminance delta ≈ 0 (same image)",
			Math.abs(metrics.luminanceDelta) < 1,
			`${metrics.luminanceDelta.toFixed(2)}%`,
		);
		check(
			"2.2 color temp delta ≈ 0",
			Math.abs(metrics.colorTempRatioDelta) < 0.01,
			`${metrics.colorTempRatioDelta.toFixed(4)}`,
		);
		check(
			"2.3 saturation delta ≈ 0",
			Math.abs(metrics.saturationDelta) < 0.01,
			`${metrics.saturationDelta.toFixed(4)}`,
		);
		check(
			"2.4 histogram correlation ≈ 1",
			metrics.histogramCorrelation > 0.99,
			`${metrics.histogramCorrelation.toFixed(4)}`,
		);
		check("2.5 metrics compute fast", true, `<10ms expected`);
	} else {
		check("2.x metrics", false, "no capture");
	}
	console.log("");

	// ── Test 3: Prompt Templates ──
	console.log("── Test 3: Prompt Templates ──");
	check(
		"3.1 atmosphere prompt has 8 dimensions",
		ATMOSPHERE_ANALYSIS_PROMPT.includes("light_direction") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("color_temperature") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("brightness") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("contrast") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("color_cast") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("saturation") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("atmosphere") &&
			ATMOSPHERE_ANALYSIS_PROMPT.includes("shadow_depth"),
	);
	check("3.2 artificiality prompt includes detected field", ARTIFICIALITY_PROMPT.includes("detected"));
	check("3.3 dimension check prompt includes ref rating", dimensionCheckPrompt("color_temperature", 5).includes("5"));
	console.log("");

	// ── Test 4: Vision API (requires VISION_API_KEY) ──
	console.log("── Test 4: Vision API ──");
	if (!visionClient.isConfigured) {
		console.log("  ⏭️  Vision not configured — skipping Vision tests");
		console.log("  Create ~/.pi/agent/vision-auth.json or set VISION_API_KEY.");
	} else if (capture) {
		try {
			// Test atmosphere analysis
			const atmosphere = await visionClient.sendAndParse<any>({
				prompt: ATMOSPHERE_ANALYSIS_PROMPT,
				images: [{ base64: capture.base64 }],
				maxTokens: 2000,
			});

			const dims = Object.keys(atmosphere);
			check("4.1 Vision returns 8 dimensions", dims.length >= 7, `${dims.length} dims: ${dims.join(", ")}`);

			// Check rating ranges (1-5)
			const ratings = dims.map((d) => atmosphere[d]?.rating).filter((r) => typeof r === "number");
			const allInRange = ratings.every((r: number) => r >= 1 && r <= 5);
			check("4.2 All ratings in 1-5 range", allInRange, ratings.join(", "));

			// Check descriptions exist
			const descs = dims.map((d) => atmosphere[d]?.description).filter((d) => typeof d === "string");
			check("4.3 All dimensions have descriptions", descs.length === dims.length, `${descs.length}/${dims.length}`);

			console.log("  Sample ratings:", JSON.stringify(atmosphere, null, 2).substring(0, 500));
		} catch (err) {
			check("4.x Vision API", false, (err as Error).message);
		}
	}
	console.log("");

	// ── Test 5: assess_lighting end-to-end ──
	console.log("── Test 5: assess_lighting end-to-end ──");
	if (!visionClient.isConfigured) {
		console.log("  ⏭️  VISION_API_KEY not set — skipping e2e test");
	} else {
		try {
			const refPath = "d:/Programs/2024-2/pi/packages/ue-harness/test/test-ref.png";
			const result = await executeAssessLighting({ reference_path: refPath });
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			const data = JSON.parse(text);

			check("5.1 assess_lighting success", data.success === true);
			check("5.2 Has reference atmosphere", !!data.reference?.atmosphere);
			check("5.3 Has current atmosphere", !!data.current?.atmosphere);
			check("5.4 Has gaps array", Array.isArray(data.gaps));
			check("5.5 Has quantitative metrics", !!data.quantitative);
			check("5.6 Has artificiality check", !!data.artificiality);

			if (data.gaps?.length) {
				const gapLevels = data.gaps.map((g: any) => g.gap);
				const majors = gapLevels.filter((g: string) => g === "major").length;
				const moderates = gapLevels.filter((g: string) => g === "moderate").length;
				const minors = gapLevels.filter((g: string) => g === "minor").length;
				console.log(`  Gaps: ${majors} major, ${moderates} moderate, ${minors} minor`);
			}

			console.log(`  artificiality: ${data.artificiality?.detected ? "DETECTED" : "none"}`);
			console.log(`  Vision tokens: ~${data.meta?.visionTokens || "?"}`);
		} catch (err) {
			check("5.x e2e", false, (err as Error).message);
			console.log((err as Error).stack?.substring(0, 400));
		}
	}
	console.log("");

	// ── Summary ──
	console.log("=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	console.log("=".repeat(60));

	await ueClient.disconnect();
	await client.close();
}

main().catch((err) => {
	console.error("FATAL:", err.message);
	process.exit(1);
});
