/**
 * Issue 008a — validateTags() 测试
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
// inline copy of validateTags from src/vision/analyzer.ts
// ═══════════════════════════════════════════

const BASE_TAG_VALUES = {
	time_of_day: ["golden_hour", "midday", "dusk", "night", "dawn", "overcast", "unspecified"],
	color_palette: ["warm", "cool", "neutral", "warm_cool_contrast", "unspecified"],
	atmosphere: ["clear", "light_fog", "heavy_fog", "mist", "haze", "storm", "unspecified"],
	light_direction: ["front", "side", "back", "top", "ambient", "low_angle", "unspecified"],
	mood: ["bright", "dark", "moody", "vibrant", "muted", "dramatic", "unspecified"],
};

const CONTROLLED_DIMENSIONS = ["time_of_day", "color_palette", "atmosphere", "light_direction", "mood"];

/** Simulated aliases (empty = no aliases for test isolation) */
const _aliases = {};

function applyAlias(dim, rawValue) {
	return _aliases[dim]?.[rawValue] ?? null;
}

function isValidTagValue(dim, value) {
	return BASE_TAG_VALUES[dim].includes(value);
}

function validateTags(raw) {
	const tags = {
		time_of_day: "unspecified",
		color_palette: "unspecified",
		atmosphere: "unspecified",
		light_direction: "unspecified",
		mood: "unspecified",
	};
	const unknownTags = [];

	for (const dim of CONTROLLED_DIMENSIONS) {
		const rawValue = String(raw[dim] ?? "unspecified");

		const aliased = applyAlias(dim, rawValue);
		if (aliased && isValidTagValue(dim, aliased)) {
			tags[dim] = aliased;
			continue;
		}

		if (isValidTagValue(dim, rawValue)) {
			tags[dim] = rawValue;
			continue;
		}

		tags[dim] = "unspecified";
		unknownTags.push({ dimension: dim, value: rawValue });
	}

	return {
		description: String(raw.description ?? ""),
		tags,
		freeformTags: Array.isArray(raw.freeformTags) ? raw.freeformTags : [],
		validation: { isValid: unknownTags.length === 0, unknownTags },
	};
}

// ═══════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════

console.log("\n── validateTags() ──\n");

// Case 1: 全部合法值
(() => {
	const result = validateTags({
		time_of_day: "golden_hour",
		color_palette: "warm",
		atmosphere: "clear",
		light_direction: "low_angle",
		mood: "dramatic",
		description: "Test desc",
		freeformTags: ["ocean"],
	});
	check("all valid → isValid=true", result.validation.isValid === true);
	check("all valid → unknownTags=[]", result.validation.unknownTags.length === 0, `${result.validation.unknownTags.length} unknown`);
	check("all valid → tags preserved", result.tags.time_of_day === "golden_hour" && result.tags.mood === "dramatic");
})();

// Case 2: 一个非法值 → 降级为 unspecified
(() => {
	const result = validateTags({
		time_of_day: "sunset",
		color_palette: "warm",
		atmosphere: "clear",
		light_direction: "front",
		mood: "bright",
		description: "",
		freeformTags: [],
	});
	check("one unknown → isValid=false", result.validation.isValid === false);
	check("one unknown → unknownTags length=1", result.validation.unknownTags.length === 1, `${result.validation.unknownTags.length} unknown`);
	check("one unknown → time_of_day downgraded", result.tags.time_of_day === "unspecified", `got "${result.tags.time_of_day}"`);
	check("one unknown → other dims preserved", result.tags.color_palette === "warm" && result.tags.mood === "bright");
})();

// Case 3: 多个非法值
(() => {
	const result = validateTags({
		time_of_day: "sunset",
		color_palette: "rainbow",
		atmosphere: "clear",
		light_direction: "front",
		mood: "bright",
		description: "",
		freeformTags: [],
	});
	check("multi unknown → isValid=false", result.validation.isValid === false);
	check("multi unknown → unknownTags length=2", result.validation.unknownTags.length === 2);
	check("multi unknown → both downgraded", result.tags.time_of_day === "unspecified" && result.tags.color_palette === "unspecified");
})();

// Case 4: 缺少维度 → 补 unspecified
(() => {
	const result = validateTags({
		color_palette: "warm",
		description: "partial",
	});
	check("missing dims → isValid=true", result.validation.isValid === true);
	check("missing dims → time_of_day=unspecified", result.tags.time_of_day === "unspecified");
	check("missing dims → color_palette preserved", result.tags.color_palette === "warm");
})();

// Case 5: freeformTags 不是数组 → 降级为 []
(() => {
	const result = validateTags({
		time_of_day: "golden_hour",
		color_palette: "warm",
		atmosphere: "clear",
		light_direction: "front",
		mood: "bright",
		freeformTags: "not_an_array",
	});
	check("bad freeformTags → downgraded to []", Array.isArray(result.freeformTags) && result.freeformTags.length === 0, `got ${JSON.stringify(result.freeformTags)}`);
})();

// Case 6: freeformTags 正常数组
(() => {
	const result = validateTags({
		time_of_day: "golden_hour",
		color_palette: "warm",
		atmosphere: "clear",
		light_direction: "front",
		mood: "bright",
		freeformTags: ["ocean", "god_rays"],
	});
	check("valid freeformTags → preserved", result.freeformTags.length === 2);
})();

// Case 7: 空输入 → 全 unspecified
(() => {
	const result = validateTags({});
	check("empty input → all unspecified", Object.values(result.tags).every((v) => v === "unspecified"));
	check("empty input → isValid=true", result.validation.isValid === true);
	check("empty input → description=''", result.description === "");
})();

// Case 8: 全 unspecified 输入 → 保持不变
(() => {
	const result = validateTags({
		time_of_day: "unspecified",
		color_palette: "unspecified",
		atmosphere: "unspecified",
		light_direction: "unspecified",
		mood: "unspecified",
	});
	check("all unspecified in → all unspecified out", Object.values(result.tags).every((v) => v === "unspecified"));
	check("all unspecified → still valid", result.validation.isValid === true);
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
