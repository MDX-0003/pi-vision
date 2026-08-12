/**
 * Issue 010c — capturePresetState 诊断脚本
 *
 * 直连 UE MCP，逐步骤打印 verbose 日志，定位丢失 actor 的原因。
 *
 * 运行: node --import tsx test/presets-010c-capture-diag.ts
 */

import { UeClient } from "../src/ue-client/mcp-client.ts";
import { ATMOSPHERE_COMPONENT_GLOBS, ATMOSPHERE_WHITELIST } from "../src/tools/atmosphere-whitelist.ts";

const DIAG = "[DIAG]";

const FIND_ACTORS = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";
const LIST_PROPS = "toolset_registry.toolsets.core.object.ObjectTools.list_properties";
const GET_PROPS = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
const GET_TRANSFORM = "toolset_registry.toolsets.core.object.ObjectTools.get_actor_transform";

function parseValue(text: string): unknown {
	try {
		const outer = JSON.parse(text);
		if (outer.returnValue !== undefined) {
			const rv = outer.returnValue;
			if (typeof rv === "string") {
				try { return JSON.parse(rv); } catch { return rv; }
			}
			return rv;
		}
		return outer;
	} catch {
		return text;
	}
}

function extractRefPaths(parsed: unknown): string[] {
	if (Array.isArray(parsed)) {
		return parsed.map((a: any) => a?.refPath || a?.path || String(a)).filter(Boolean);
	}
	return [];
}

async function main() {
	const ueClient = new UeClient({ ueMcpUrl: process.env.UE_MCP_URL || "http://localhost:8000/mcp" });

	try {
		await ueClient.connect();
		console.log(`${DIAG} Connected to UE MCP at ${process.env.UE_MCP_URL || "http://localhost:8000/mcp"}`);
	} catch (e) {
		console.error(`${DIAG} Failed to connect: ${(e as Error).message}`);
		process.exit(1);
	}

	console.log(`${DIAG} === capturePresetState diagnostic ===\n`);

	let captured = 0;
	const missing: string[] = [];
	const skipped: string[] = [];
	const total = ATMOSPHERE_COMPONENT_GLOBS.filter((c) => c.label !== "POSTPROCESS");

	for (const cfg of total) {
		console.log(`${DIAG} --- ${cfg.actorClass} (glob: "${cfg.glob}") ---`);

		// Step 1: find_actors
		const faResult = await ueClient.callTool(FIND_ACTORS, { glob: cfg.glob, tag: "" });
		if (faResult.isError) {
			console.error(`${DIAG}   find_actors ERROR: [${faResult.errorType}] ${faResult.text.substring(0, 200)}`);
			skipped.push(`${cfg.actorClass} (find_actors error: ${faResult.errorType})`);
			continue;
		}

		const found = parseValue(faResult.text);
		const refPaths = extractRefPaths(found);
		console.log(`${DIAG}   find_actors → ${refPaths.length} actor(s)`);

		if (refPaths.length === 0) {
			console.log(`${DIAG}   ✗ missing (no actors found)`);
			missing.push(cfg.actorClass);
			continue;
		}

		for (const actorRefPath of refPaths) {
			console.log(`${DIAG}     actorRefPath: ${actorRefPath}`);

			// Step 2: resolve component refPath
			if (cfg.compKeys.length === 0) {
				console.log(`${DIAG}     no component keys — using actor refPath directly`);
				console.log(`${DIAG}     ✗ skipped (PostProcessVolume pattern)`);
				continue;
			}

			const gpResult = await ueClient.callTool(GET_PROPS, {
				instance: { refPath: actorRefPath },
				properties: cfg.compKeys,
			});
			if (gpResult.isError) {
				console.error(`${DIAG}     resolveComponentRefPaths ERROR: [${gpResult.errorType}] ${gpResult.text.substring(0, 200)}`);
				skipped.push(`${cfg.actorClass} (resolve error)`);
				continue;
			}

			const compData = parseValue(gpResult.text) as Record<string, any> | null;
			let resolvedRefPath = "";
			for (const key of cfg.compKeys) {
				if (compData?.[key]?.refPath) {
					resolvedRefPath = compData[key].refPath;
					console.log(`${DIAG}     compRefPath: ${resolvedRefPath}`);
					break;
				}
			}
			if (!resolvedRefPath) {
				console.log(`${DIAG}     ✗ component refPath not found in keys: ${cfg.compKeys.join(", ")}`);
				console.log(`${DIAG}       raw response: ${JSON.stringify(compData).substring(0, 200)}`);
				continue;
			}

			// Step 3: list_properties
			const lpResult = await ueClient.callTool(LIST_PROPS, {
				instance: { refPath: resolvedRefPath },
			});
			if (lpResult.isError) {
				console.error(`${DIAG}     list_properties ERROR: [${lpResult.errorType}] ${lpResult.text.substring(0, 200)}`);
				skipped.push(`${cfg.actorClass} (list_props error)`);
				continue;
			}

			const compProps = parseValue(lpResult.text);
			const propKeys = typeof compProps === "object" && compProps !== null ? Object.keys(compProps) : [];
			console.log(`${DIAG}     list_properties → ${propKeys.length} properties`);

			// Step 4: whitelist match
			const relevantProps = ATMOSPHERE_WHITELIST.filter((a) => a.componentClass === cfg.compClass);
			const propNames = [...new Set(relevantProps.map((a) => a.property))];
			console.log(`${DIAG}     whitelist match: [${propNames.join(", ") || "(none)"}]`);

			if (propNames.length === 0) {
				console.log(`${DIAG}     ✗ no whitelist properties for ${cfg.compClass}`);
				continue;
			}

			// Step 5: get_properties
			const gvResult = await ueClient.callTool(GET_PROPS, {
				instance: { refPath: resolvedRefPath },
				properties: propNames,
			});
			if (gvResult.isError) {
				console.error(`${DIAG}     get_properties ERROR: [${gvResult.errorType}] ${gvResult.text.substring(0, 200)}`);
				skipped.push(`${cfg.actorClass} (get_props error)`);
				continue;
			}

			const propValues = parseValue(gvResult.text) as Record<string, unknown>;
			for (const pn of propNames) {
				const val = propValues?.[pn];
				const display = typeof val === "object" ? JSON.stringify(val) : String(val);
				console.log(`${DIAG}       ${pn} = ${display}`);
			}

			// Step 6: transform (DirectionalLight only)
			if (cfg.actorClass === "DirectionalLight") {
				const gtResult = await ueClient.callTool(GET_TRANSFORM, {
					instance: { refPath: actorRefPath },
				});
				if (gtResult.isError) {
					console.log(`${DIAG}     get_actor_transform ERROR: [${gtResult.errorType}] ${gtResult.text.substring(0, 100)}`);
				} else {
					const gtData = parseValue(gtResult.text) as any;
					if (gtData?.rotation) {
						console.log(`${DIAG}     rotation: Pitch=${gtData.rotation.Pitch ?? gtData.rotation.pitch}, Yaw=${gtData.rotation.Yaw ?? gtData.rotation.yaw}, Roll=${gtData.rotation.Roll ?? gtData.rotation.roll}`);
					}
				}
			}

			console.log(`${DIAG}   ✓ captured`);
			captured++;
		}
	}

	// Summary
	console.log(`\n${DIAG} === Summary ===`);
	console.log(`${DIAG} Captured: ${captured} actor(s)`);
	const capturedNames = []; // not tracking names in diag
	if (missing.length > 0) {
		console.log(`${DIAG} Missing (find_actors returned []): [${missing.join(", ")}]`);
	}
	if (skipped.length > 0) {
		console.log(`${DIAG} Skipped (error): [${skipped.join(", ")}]`);
	}
	console.log(`${DIAG} Total expected: ${total.length} component types`);

	await ueClient.disconnect();
}

main().catch((e) => {
	console.error(`${DIAG} Fatal:`, e);
	process.exit(1);
});
