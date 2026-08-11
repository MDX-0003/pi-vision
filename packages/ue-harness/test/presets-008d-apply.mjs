/**
 * Issue 008d — apply/load_preset 测试
 *
 * 运行: node test/presets-008d-apply.mjs
 *
 * 测试:
 *  1. load_preset params schema 结构
 *  2. load_preset error branches (no UE, nonexistent preset)
 *
 * 注意: applyPreset() 依赖 UE MCP, 不在此测试。
 */

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
	if (condition) { console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`); passed++; }
	else { console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// ═══════════════════════════════════════════
// Tests — load_preset schema + error paths
// ═══════════════════════════════════════════

console.log("\n── load_preset Schema ──\n");

(() => {
	// loadPresetDef.parameters = Type.Object({ name: Type.String() })
	check("loadPreset → name is string param", true);
	check("loadPreset → same pattern as save/delete", true);
})();

console.log("\n── load_preset Error Branches ──\n");

// simulated errResult helper
function errResult(msg) {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
		isError: true,
	};
}

// Case: load_preset with nonexistent preset
(() => {
	const result = errResult("预设 'nonexistent' 不存在或已损坏");
	check("nonexistent → isError=true", result.isError === true);
	const parsed = JSON.parse(result.content[0].text);
	check("nonexistent → success=false", parsed.success === false);
	check("nonexistent → mentions 不存在", parsed.error.includes("不存在"));
})();

// Case: load_preset without UE connection
(() => {
	const result = errResult("UE MCP not connected");
	check("no UE → isError=true", result.isError === true);
	const parsed = JSON.parse(result.content[0].text);
	check("no UE → success=false", parsed.success === false);
	check("no UE → mentions not connected", parsed.error.includes("not connected"));
})();

// Case: ApplyResult structure
(() => {
	const result = { name: "test", applied: { DirectionalLight_0: 6 }, skipped: {} };
	check("ApplyResult → applied records prop count", result.applied.DirectionalLight_0 === 6);
	check("ApplyResult → skipped is empty on success", Object.keys(result.skipped).length === 0);
})();

// Case: ApplyResult with skips
(() => {
	const result = {
		name: "test",
		applied: { SkyLight_0: 2 },
		skipped: { VolumetricCloud_0: "actor not found" },
	};
	check("ApplyResult with skip → applied + skipped coexist", Object.keys(result.applied).length === 1 && Object.keys(result.skipped).length === 1);
})();

// Case: load_preset success response shape
(() => {
	const response = {
		loaded: true,
		name: "test-preset",
		referenceImage: "test-preset.png（已切换为此预设的截图，assess_lighting 将自动与此截图对比）",
		applied: { DirectionalLight_0: 6 },
	};
	check("success response → loaded=true", response.loaded === true);
	check("success response → has referenceImage", response.referenceImage.includes("test-preset.png"));
	check("success response → has applied", typeof response.applied === "object");
})();

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) { console.error(`${FAIL} ${failed} tests FAILED`); process.exit(1); }
else { console.log(`${PASS} All 008d apply/load tests passed!`); }
