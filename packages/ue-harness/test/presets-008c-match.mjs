/**
 * Issue 008c — matchPresetsByTags() + buildPresetSuggestion() 测试
 *
 * 运行: node test/presets-008c-match.mjs
 */

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
// inline copy of matchPresetsByTags
// ═══════════════════════════════════════════

const CONTROLLED_DIMENSIONS = ["time_of_day", "color_palette", "atmosphere", "light_direction", "mood"];

function matchPresetsByTags(queryTags, queryFreeform, presets) {
	const results = [];
	for (const preset of presets) {
		let hits = 0, comparable = 0;
		const matchedDims = [];
		for (const dim of CONTROLLED_DIMENSIONS) {
			const q = queryTags[dim], p = preset.tags[dim];
			if (q === "unspecified" || p === "unspecified") continue;
			comparable++;
			if (q === p) { hits++; matchedDims.push(dim); }
		}
		if (comparable < 2) continue;
		const controlledScore = hits / comparable;
		const intersection = queryFreeform.filter((t) => preset.freeformTags.includes(t)).length;
		const union = new Set([...queryFreeform, ...preset.freeformTags]).size;
		const freeformScore = union > 0 ? intersection / union : 0;
		const score = controlledScore * 0.85 + freeformScore * 0.15;
		if (score >= 0.5 && hits >= 2) {
			results.push({ name: preset.name, description: preset.description, score: Math.round(score * 100) / 100, matchedDimensions: matchedDims });
		}
	}
	return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 3);
}

// ═══════════════════════════════════════════
// inline copy of buildPresetSuggestion
// ═══════════════════════════════════════════

function buildPresetSuggestion(matches) {
	if (!matches || matches.length === 0) return "";
	let text = "\n## 匹配的预设\n\n";
	text += "以下预设与当前参考图的氛围特征相似，可提供更好的调参起点:\n";
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		text += `  [${i + 1}] ${m.name} (标签匹配: ${m.matchedDimensions.length}/5, 得分 ${m.score})\n`;
		text += `      ${m.description}\n`;
		text += `      匹配维度: ${m.matchedDimensions.join(", ")}\n`;
	}
	text += "\n如果你认为某个预设比当前默认场景更适合作为起点:\n";
	text += "  调 load_preset('name') 批量应用该预设 → 调 assess_lighting() 检验效果\n";
	text += "\n不使用预设则忽略此建议，继续手动调参。\n";
	text += "\n(unspecified = 该维度在此预设或参考图中无法归类，已自动忽略不计分)\n";
	return text;
}

// ═══════════════════════════════════════════
// Helper: make tags
// ═══════════════════════════════════════════

function makeTags(timeOfDay, colorPalette, atmosphere, lightDirection, mood) {
	return { time_of_day: timeOfDay, color_palette: colorPalette, atmosphere, light_direction: lightDirection, mood };
}

function makePreset(name, tags, freeformTags, description) {
	return { name, description: description || `Preset ${name}`, tags, freeformTags: freeformTags || [] };
}

// ═══════════════════════════════════════════
// Tests — matchPresetsByTags
// ═══════════════════════════════════════════

console.log("\n── matchPresetsByTags() ──\n");

// Case 1: 完美匹配（5/5）
(() => {
	const query = makeTags("golden_hour", "warm", "heavy_fog", "low_angle", "dramatic");
	const preset = makePreset("test", makeTags("golden_hour", "warm", "heavy_fog", "low_angle", "dramatic"));
	const results = matchPresetsByTags(query, [], [preset]);
	check("5/5 match → score = 0.85", results.length === 1 && results[0].score === 0.85, `score=${results[0]?.score}`);
	check("5/5 match → 5 matched dims", results[0]?.matchedDimensions.length === 5);
})();

// Case 2: 3/5 匹配
(() => {
	const query = makeTags("golden_hour", "warm", "clear", "top", "dramatic");
	const preset = makePreset("test", makeTags("golden_hour", "warm", "heavy_fog", "low_angle", "dramatic"));
	const results = matchPresetsByTags(query, [], [preset]);
	check("3/5 match → score >= 0.5", results.length === 1 && results[0].score >= 0.5, `score=${results[0]?.score}`);
	check("3/5 match → 3 matched dims", results[0]?.matchedDimensions.length === 3);
})();

// Case 3: 双方各有 unspecified → 只比较重叠的非 unspecified 维度
(() => {
	const query = makeTags("golden_hour", "unspecified", "heavy_fog", "low_angle", "dramatic");
	const preset = makePreset("test", makeTags("golden_hour", "warm", "unspecified", "low_angle", "bright"));
	const results = matchPresetsByTags(query, [], [preset]);
	// comparable: time_of_day, light_direction, mood = 3
	// hits: time_of_day, light_direction = 2
	check("mixed unspecified → hits=2", results.length === 1 && results[0].matchedDimensions.length === 2);
	check("mixed unspecified → score ≈ 0.57", results.length === 1 && results[0].score >= 0.5, `score=${results[0]?.score}`);
})();

// Case 4: comparable < 2 → 不匹配
(() => {
	const query = makeTags("golden_hour", "unspecified", "unspecified", "unspecified", "unspecified");
	const preset = makePreset("test", makeTags("dusk", "unspecified", "unspecified", "unspecified", "unspecified"));
	const results = matchPresetsByTags(query, [], [preset]);
	check("comparable=1 → no match", results.length === 0);
})();

// Case 5: 全 unspecified → 不匹配
(() => {
	const query = makeTags("unspecified", "unspecified", "unspecified", "unspecified", "unspecified");
	const preset = makePreset("test", makeTags("unspecified", "unspecified", "unspecified", "unspecified", "unspecified"));
	const results = matchPresetsByTags(query, [], [preset]);
	check("all unspecified → no match", results.length === 0);
})();

// Case 6: 自由标签 Jaccard 加分
(() => {
	const query = makeTags("golden_hour", "warm", "clear", "front", "bright");
	const preset = makePreset("test", makeTags("golden_hour", "warm", "clear", "front", "bright"), ["ocean", "silhouette"]);
	const resultsNoFree = matchPresetsByTags(query, [], [preset]);
	const resultsFree = matchPresetsByTags(query, ["ocean", "god_rays"], [preset]);
	// freeform intersection=1 ("ocean"), union=3 ("ocean","god_rays","silhouette"), freeformScore=0.33, +0.05
	check("freeform → score increases", resultsFree[0].score > resultsNoFree[0].score, `diff: ${(resultsFree[0].score - resultsNoFree[0].score).toFixed(2)}`);
})();

// Case 7: 空自由标签
(() => {
	const query = makeTags("golden_hour", "warm", "clear", "front", "bright");
	const preset = makePreset("test", makeTags("golden_hour", "warm", "clear", "front", "bright"), ["ocean"]);
	const results = matchPresetsByTags(query, [], [preset]);
	check("empty freeform → no bonus", results.length === 1 && results[0].score === 0.85, `score=${results[0]?.score}`);
})();

// Case 8: top-3 排序
(() => {
	const presets = [
		makePreset("low", makeTags("golden_hour", "cool", "clear", "front", "muted")),
		makePreset("high", makeTags("golden_hour", "warm", "heavy_fog", "low_angle", "dramatic")),
		makePreset("mid", makeTags("golden_hour", "warm", "clear", "front", "dramatic")),
		makePreset("superlow", makeTags("dusk", "cool", "storm", "top", "muted")),
	];
	const query = makeTags("golden_hour", "warm", "heavy_fog", "low_angle", "dramatic");
	const results = matchPresetsByTags(query, [], presets);
	check("top-3 → returns at most 3", results.length <= 3);
	check("top-3 → best match first", results[0].name === "high", `got ${results[0]?.name}`);
})();

// Case 9: hits < 2 → excluded even if score >= 0.5
(() => {
	const query = makeTags("golden_hour", "warm", "clear", "unspecified", "unspecified");
	const preset = makePreset("test", makeTags("golden_hour", "cool", "unspecified", "unspecified", "unspecified"));
	const results = matchPresetsByTags(query, [], [preset]);
	// comparable=2 (time_of_day, color_palette), hits=1 (only time_of_day)
	check("hits=1 comparable=2 → no match", results.length === 0);
})();

// Case 10: 分数相同的确定性排序
(() => {
	const presets = [
		makePreset("b-preset", makeTags("golden_hour", "warm", "clear", "front", "bright")),
		makePreset("a-preset", makeTags("golden_hour", "warm", "clear", "front", "bright")),
	];
	const query = makeTags("golden_hour", "warm", "clear", "front", "bright");
	const results = matchPresetsByTags(query, [], presets);
	check("same score → alphabetically sorted", results[0].name === "a-preset", `got ${results[0]?.name}`);
})();

// ═══════════════════════════════════════════
// Tests — buildPresetSuggestion
// ═══════════════════════════════════════════

console.log("\n── buildPresetSuggestion() ──\n");

(() => {
	const text = buildPresetSuggestion([
		{ name: "golden-hour", description: "Warm sunset scene", score: 0.92, matchedDimensions: ["time_of_day", "color_palette", "atmosphere", "light_direction"] },
	]);
	check("suggestion → contains preset name", text.includes("golden-hour"));
	check("suggestion → contains score", text.includes("0.92"));
	check("suggestion → contains matched count", text.includes("4/5"));
	check("suggestion → contains load_preset hint", text.includes("load_preset"));
	check("suggestion → contains unspecified note", text.includes("unspecified"));
})();

(() => {
	check("empty matches → returns empty string", buildPresetSuggestion([]) === "");
	check("null matches → returns empty string", buildPresetSuggestion(null) === "");
})();

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`${FAIL} ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`${PASS} All 008c match tests passed!`);
}
