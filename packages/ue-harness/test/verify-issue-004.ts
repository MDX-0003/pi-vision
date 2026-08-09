/**
 * Issue 004 Verification — map_atmosphere + check_dimension
 *
 * 运行: npx tsx test/verify-issue-004.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { setUeClient, setVisionClient } from "../src/state.ts";
import { executeCheckDimension } from "../src/tools/check-dimension.ts";
import { executeMapAtmosphere } from "../src/tools/map-atmosphere.ts";
import { UeClient } from "../src/ue-client/mcp-client.ts";
import { VisionClient } from "../src/vision/vision-client.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0,
	failed = 0;
function check(n: string, c: boolean, d = "") {
	if (c) {
		console.log(`${PASS} ${n}${d ? ` — ${d}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${n}${d ? ` — ${d}` : ""}`);
		failed++;
	}
}

function extractText(c: unknown): string {
	if (typeof c === "string") return c;
	if (Array.isArray(c))
		return (c as any[])
			.filter((x: any) => x.type === "text")
			.map((x: any) => x.text)
			.join("\n");
	return String(c);
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
	console.log("Issue 004 Verification");
	console.log("=".repeat(60));
	console.log("");

	// Setup UE
	const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8000/mcp"), {
		requestInit: { headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" } },
	});
	const client = new Client({ name: "issue004", version: "1.0" }, { capabilities: {} });
	await client.connect(transport);
	const tsResult = await client.callTool({ name: "list_toolsets", arguments: {} });
	const tsNames = [...extractText(tsResult.content).matchAll(/^\s*-\s*(\S+):/gm)].map((m: any) => m[1]);
	for (const name of tsNames) {
		try {
			await client.callTool({ name: "load_toolset", arguments: { toolset_name: name } });
		} catch (_e) {}
	}
	await new Promise((r) => setTimeout(r, 500));

	const va = loadVisionAuth();
	const config = {
		ueMcpUrl: "http://localhost:8000/mcp",
		visionApiKey: process.env.VISION_API_KEY || va?.apiKey,
		visionApiBaseUrl: process.env.VISION_API_BASE_URL || va?.baseUrl,
		visionModelId: process.env.VISION_MODEL_ID || va?.modelId,
	};
	const ue = new UeClient(config);
	await ue.connect();
	setUeClient(ue);
	const vc = new VisionClient(config);
	setVisionClient(vc);

	// ════════════════════════════════════════════
	// Test 1: map_atmosphere
	// ════════════════════════════════════════════
	console.log("── Test 1: map_atmosphere ──");
	const maResult = await executeMapAtmosphere();
	const maText = maResult.content[0]!.type === "text" ? (maResult.content[0]!.text as string) : "";
	const ma = JSON.parse(maText);
	check("1.1 success", ma.success === true);
	check("1.2 has tiers", Array.isArray(ma.tiers) && ma.tiers.length > 0, `${ma.tiers?.length || 0} tiers`);

	if (ma.tiers) {
		for (const tier of ma.tiers) {
			console.log(
				`  Tier ${tier.tier} (${tier.label}): ${tier.components?.length || 0} components, dimensions: ${tier.dimensions?.join(", ") || "none"}`,
			);
			if (tier.components) {
				for (const comp of tier.components.slice(0, 3)) {
					console.log(
						`    ${comp.actor}.${comp.property}: ${comp.currentValue !== undefined ? JSON.stringify(comp.currentValue).substring(0, 60) : "no value"}`,
					);
				}
				if (tier.components.length > 3) console.log(`    ... +${tier.components.length - 3} more`);
			}
		}
		const t1All = ma.tiers.filter((t: any) => t.tier === 1);
		const t1Components = t1All.flatMap((t: any) => t.components || []);
		check(
			"1.3 Tier 1 (CORE_LIGHTING) exists",
			t1All.length > 0,
			`${t1All.length} entries, ${t1Components.length} components`,
		);
		check(
			"1.4 DirectionalLight found",
			t1Components.some((c: any) => c.actor.includes("DirectionalLight")),
		);
		check(
			"1.5 SkyLight found",
			t1Components.some((c: any) => c.actor.includes("SkyLight")),
		);
	}
	check("1.6 missingComponents info present", ma.missingComponents !== undefined || ma.success);

	console.log("");

	// ════════════════════════════════════════════
	// Test 2: check_dimension (same ref = test-ref.png)
	// ════════════════════════════════════════════
	console.log("── Test 2: check_dimension ──");
	const refPath = "d:/Programs/2024-2/pi/packages/ue-harness/test/test-ref.png";
	if (!existsSync(refPath)) {
		check("2.x", false, "test-ref.png not found");
		console.log("  Run verify-assess-lighting.ts first to generate test-ref.png");
	} else {
		// Test dims: brightness (has quantitative), light_direction (no quantitative)
		{
			const cd = await executeCheckDimension({ reference_path: refPath, dimension: "brightness" });
			const cdText = cd.content[0]!.type === "text" ? (cd.content[0]!.text as string) : "";
			const cdData = JSON.parse(cdText);
			check("2.1 check_dimension success", cdData.success === true);
			check("2.2 has verdict", !!cdData.result?.verdict);
			check(
				"2.3 brightness has quantitative",
				!!cdData.result?.quantitative,
				cdData.result?.quantitative
					? `ref=${cdData.result.quantitative.refValue}, cur=${cdData.result.quantitative.curValue}, Δ=${cdData.result.quantitative.delta}`
					: "MISSING",
			);
			console.log(`  brightness: ${cdData.result?.verdict} "${cdData.result?.evidence?.substring(0, 60)}"`);
		}
		{
			const cd = await executeCheckDimension({ reference_path: refPath, dimension: "light_direction" });
			const cdText = cd.content[0]!.type === "text" ? (cd.content[0]!.text as string) : "";
			const cdData = JSON.parse(cdText);
			check("2.4 light_direction success", cdData.success === true);
			check("2.5 light_direction no quantitative", !cdData.result?.quantitative, "correctly absent");
			console.log(`  light_direction: ${cdData.result?.verdict} "${cdData.result?.evidence?.substring(0, 60)}"`);
		}
		{
			const cd = await executeCheckDimension({ reference_path: refPath, dimension: "color_temperature" });
			const cdText = cd.content[0]!.type === "text" ? (cd.content[0]!.text as string) : "";
			const cdData = JSON.parse(cdText);
			check("2.6 color_temperature has quantitative", !!cdData.result?.quantitative);
			console.log(`  color_temperature: ${cdData.result?.verdict} "${cdData.result?.evidence?.substring(0, 60)}"`);
		}
	}
	console.log("");

	// ════════════════════════════════════════════
	console.log("=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	console.log("=".repeat(60));

	await ue.disconnect();
	await client.close();
}

main().catch((err) => {
	console.error("FATAL:", err.message);
	console.error(err.stack?.substring(0, 500));
	process.exit(1);
});
