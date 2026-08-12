/**
 * Issue 010a — matchPresetsByTags() + buildPresetSuggestion() 测试（简化版：Jaccard）
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
// inline copy of matchPresetsByTags (Issue 010a)
// ═══════════════════════════════════════════

function jaccardTagScore(queryTags, presetTags) {
	const intersection = queryTags.filter((t) => presetTags.includes(t)).length;
	const union = new Set([...queryTags, ...presetTags]).size;
	return union > 0 ? intersection / union : 0;
}

function matchPresetsByTags(queryTags, presets, options) {
	const scorer = options?.scorer ?? jaccardTagScore;
	const topN = options?.topN ?? 10;

	const results = [];
	for (const preset of presets) {
		const score = scorer(queryTags, preset.tags);
		if (score > 0) {
			results.push({
				name: preset.name,
				description: preset.description,
				score: Math.round(score * 100) / 100,
				matchedTags: queryTags.filter((t) => preset.tags.includes(t)),
			});
		}
	}

	return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, topN);
}

// ═══════════════════════════════════════════
// inline copy of buildPresetSuggestion (Issue 010a)
// ═══════════════════════════════════════════

function buildPresetSuggestion(matches) {
	if (!matches || matches.length === 0) return "";
	let text = "\n## 匹配的预设\n\n";
	text += "以下预设与当前参考图的氛围特征相似，可提供更好的调参起点:\n";
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		text += `  [${i + 1}] ${m.name} (匹配标签: ${m.matchedTags.join(", ")}, 得分 ${m.score})\n`;
		text += `      ${m.description}\n`;
	}
	text += "\n如果你认为某个预设比当前默认场景更适合作为起点:\n";
	text += "  调 load_preset('name') 批量应用该预设 → 调 assess_lighting() 检验效果\n";
	text += "\n不使用预设则忽略此建议，继续手动调参。\n";
	return text;
}

// ═══════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════

function makePreset(name, tags, description) {
	return { name, description: description || `Preset ${name}`, tags: tags || [] };
}

// ═══════════════════════════════════════════
// Tests — jaccardTagScore
// ═══════════════════════════════════════════

console.log("\n── jaccardTagScore() ──\n");

(() => {
	check("identical → 1.0", jaccardTagScore(["a", "b"], ["a", "b"]) === 1.0);
	check("half overlap → 0.33", jaccardTagScore(["a", "b"], ["a", "c"]).toFixed(2) === "0.33", `${jaccardTagScore(["a", "b"], ["a", "c"])}`);
	check("no overlap → 0", jaccardTagScore(["a"], ["b"]) === 0);
	check("both empty → 0", jaccardTagScore([], []) === 0);
	check("query empty → 0", jaccardTagScore([], ["a"]) === 0);
	check("preset empty → 0", jaccardTagScore(["a"], []) === 0);
})();

// ═══════════════════════════════════════════
// Tests — matchPresetsByTags
// ═══════════════════════════════════════════

console.log("\n── matchPresetsByTags() ──\n");

// Case 1: 完全匹配 → 返回唯一结果
(() => {
	const preset = makePreset("perfect", ["golden_hour", "warm", "ocean"]);
	const results = matchPresetsByTags(["golden_hour", "warm", "ocean"], [preset]);
	check("full match → score=1.0", results.length === 1 && results[0].score === 1.0);
	check("full match → all tags matched", results[0].matchedTags.length === 3);
})();

// Case 2: 部分匹配
(() => {
	const preset = makePreset("partial", ["golden_hour", "warm", "ocean"]);
	const results = matchPresetsByTags(["golden_hour", "cool", "ocean"], [preset]);
	check("2/3 match → score=0.5", results.length === 1 && results[0].score === 0.5, `score=${results[0]?.score}`);
	check("2/3 match → 2 matched tags", results[0].matchedTags.length === 2);
})();

// Case 3: 零匹配 → 不返回
(() => {
	const preset = makePreset("none", ["golden_hour", "warm"]);
	const results = matchPresetsByTags(["cool", "night"], [preset]);
	check("zero overlap → no result", results.length === 0);
})();

// Case 4: 单个 tag 匹配
(() => {
	const preset = makePreset("single", ["golden_hour", "ocean", "warm"]);
	const results = matchPresetsByTags(["golden_hour", "cool", "night"], [preset]);
	check("1 tag match → score > 0", results.length === 1 && results[0].score > 0, `score=${results[0]?.score}`);
	check("1 tag match → matchedTags=['golden_hour']", results[0].matchedTags.length === 1 && results[0].matchedTags[0] === "golden_hour");
})();

// Case 5: 空查询标签 → 无匹配
(() => {
	const preset = makePreset("test", ["a", "b"]);
	const results = matchPresetsByTags([], [preset]);
	check("empty query → no result", results.length === 0);
})();

// Case 6: top-10 排序
(() => {
	const presets = [
		makePreset("best", ["a", "b", "c", "d"]),
		makePreset("good", ["a", "b", "c"]),
		makePreset("ok", ["a", "b"]),
		makePreset("meh", ["a"]),
		makePreset("none", ["x"]),
	];
	const query = ["a", "b", "c", "d"];
	const results = matchPresetsByTags(query, presets);
	check("top-10 → returns up to 10", results.length <= 10);
	check("top-10 → best first", results[0].name === "best", `got ${results[0]?.name}`);
	check("top-10 → zero overlap excluded", results.length === 4, `got ${results.length}`);
	check("top-10 → sorted by score desc", results[0].score >= results[1].score);
})();

// Case 7: score 相同 → 按名称字母序
(() => {
	const presets = [
		makePreset("b-preset", ["golden_hour"]),
		makePreset("a-preset", ["golden_hour"]),
	];
	const results = matchPresetsByTags(["golden_hour"], presets);
	check("same score → alpha sort", results[0].name === "a-preset", `got ${results[0]?.name}`);
})();

// Case 8: 超过 topN 个结果 → 截断
(() => {
	const presets = [];
	for (let i = 0; i < 15; i++) {
		presets.push(makePreset(`p-${i}`, [`tag-${i % 3}`, "common"]));
	}
	const results = matchPresetsByTags(["common"], presets);
	check("15 candidates → returns top-10", results.length === 10);
})();

// Case 9: 自定义 scorer（验证 options.scorer 接入）
(() => {
	const preset = makePreset("custom", ["a", "b"]);
	const results = matchPresetsByTags(["a"], [preset], { scorer: () => 0.99, topN: 5 });
	check("custom scorer → uses provided scorer", results.length === 1 && results[0].score === 0.99);
})();

// Case 10: 自定义 topN
(() => {
	const presets = [
		makePreset("p1", ["common"]),
		makePreset("p2", ["common"]),
		makePreset("p3", ["common"]),
		makePreset("p4", ["common"]),
		makePreset("p5", ["common"]),
	];
	const results = matchPresetsByTags(["common"], presets, { topN: 3 });
	check("custom topN=3 → returns 3", results.length === 3, `got ${results.length}`);
})();

// ═══════════════════════════════════════════
// Tests — buildPresetSuggestion
// ═══════════════════════════════════════════

console.log("\n── buildPresetSuggestion() ──\n");

(() => {
	const text = buildPresetSuggestion([
		{ name: "golden-hour", description: "Warm sunset scene", score: 0.92, matchedTags: ["golden_hour", "ocean", "god_rays"] },
	]);
	check("suggestion → contains preset name", text.includes("golden-hour"));
	check("suggestion → contains score", text.includes("0.92"));
	check("suggestion → contains matched tags", text.includes("golden_hour"));
	check("suggestion → contains load_preset hint", text.includes("load_preset"));
	check("suggestion → NO unspecified note", !text.includes("unspecified"));
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
	console.log(`${PASS} All 010a match tests passed!`);
}
