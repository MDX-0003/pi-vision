/**
 * Issue 010a — validateTags() 测试（简化版：开放式标签，无受控维度）
 *
 * 运行: node test/presets-008a-validation.mjs
 *
 * 源文件: src/vision/analyzer.ts — validateTags()
 * 逻辑在此内联以支持纯 .mjs 运行（无需 tsx）
 */

import { ok, deepEqual } from "node:assert/strict";

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
	if (condition) {
		console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

// ═══════════════════════════════════════════
// inline copy of simplified validateTags (Issue 010a)
// ═══════════════════════════════════════════

function validateTags(raw) {
	return {
		description: String(raw.description ?? ""),
		tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string").slice(0, 5) : [],
	};
}

// ═══════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════

console.log("\n── validateTags() (simplified) ──\n");

// Case 1: 正常输入
(() => {
	const result = validateTags({
		description: "Warm golden hour over ocean horizon",
		tags: ["golden_hour", "ocean_horizon", "god_rays"],
	});
	check("normal → description preserved", result.description === "Warm golden hour over ocean horizon");
	check("normal → tags length=3", result.tags.length === 3);
	check("normal → tags content preserved", result.tags[0] === "golden_hour" && result.tags[2] === "god_rays");
})();

// Case 2: tags 截断 > 5
(() => {
	const result = validateTags({
		tags: ["a", "b", "c", "d", "e", "f", "g"],
	});
	check("overflow → truncated to 5", result.tags.length === 5);
	check("overflow → preserves first 5", result.tags[0] === "a" && result.tags[4] === "e");
})();

// Case 3: tags 不是数组 → 降级为 []
(() => {
	const result = validateTags({ tags: "not_an_array" });
	check("bad tags → []", result.tags.length === 0, `got ${JSON.stringify(result.tags)}`);
})();

// Case 4: tags 含非字符串元素 → 过滤
(() => {
	const result = validateTags({ tags: ["valid", 123, true, "also_valid", null] });
	check("mixed types → only strings kept", result.tags.length === 2);
	check("mixed types → correct strings", result.tags[0] === "valid" && result.tags[1] === "also_valid");
})();

// Case 5: 空输入
(() => {
	const result = validateTags({});
	check("empty input → tags=[]", result.tags.length === 0);
	check("empty input → description=''", result.description === "");
})();

// Case 6: 空 tags 数组
(() => {
	const result = validateTags({ tags: [] });
	check("empty tags → tags=[]", result.tags.length === 0);
})();

// Case 7: description 非字符串 → 转字符串
(() => {
	const result = validateTags({ description: 12345 });
	check("non-string desc → '12345'", result.description === "12345");
})();

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`${FAIL} ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`${PASS} All validateTags tests passed!`);
}
