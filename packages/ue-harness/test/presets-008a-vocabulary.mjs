/**
 * Issue 008a — getEffectiveVocabulary() + buildTaggingPrompt() 测试
 *
 * 运行: node test/presets-008a-vocabulary.mjs
 *
 * 源文件: src/vision/analyzer.ts + src/vision/prompts.ts
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
// inline copy from src/vision/analyzer.ts
// ═══════════════════════════════════════════

const BASE_TAG_VALUES = {
	time_of_day: ["golden_hour", "midday", "dusk", "night", "dawn", "overcast", "unspecified"],
	color_palette: ["warm", "cool", "neutral", "warm_cool_contrast", "unspecified"],
	atmosphere: ["clear", "light_fog", "heavy_fog", "mist", "haze", "storm", "unspecified"],
	light_direction: ["front", "side", "back", "top", "ambient", "low_angle", "unspecified"],
	mood: ["bright", "dark", "moody", "vibrant", "muted", "dramatic", "unspecified"],
};

const CONTROLLED_DIMENSIONS = ["time_of_day", "color_palette", "atmosphere", "light_direction", "mood"];

let _customVocabulary = {};

function getEffectiveVocabulary(dim) {
	const base = [...BASE_TAG_VALUES[dim]];
	const custom = _customVocabulary[dim] ?? [];
	return [...new Set([...base, ...custom])];
}

// ═══════════════════════════════════════════
// inline copy of buildTaggingPrompt from src/vision/prompts.ts
// ═══════════════════════════════════════════

const TAG_DESCRIPTIONS = {
	time_of_day: [
		{ value: "golden_hour", desc: "温暖的倾斜低角度日光，长阴影，橙/金色调" },
		{ value: "midday", desc: "明亮的顶光，短阴影，中性白光" },
		{ value: "dusk", desc: "黄昏，太阳低于地平线但天空仍有色彩，紫/粉色调" },
		{ value: "night", desc: "夜晚场景，月光或人造光源照明" },
		{ value: "dawn", desc: "清晨，冷调淡色，太阳接近地平线" },
		{ value: "overcast", desc: "阴天漫射光，无明确太阳方向，灰调天空感" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	color_palette: [
		{ value: "warm", desc: "全局暖调（橙/金色）" },
		{ value: "cool", desc: "全局冷调（蓝/白）" },
		{ value: "neutral", desc: "自然中性色调" },
		{ value: "warm_cool_contrast", desc: "画面不同区域有明显色温差异（暖高光 + 冷阴影）" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	atmosphere: [
		{ value: "clear", desc: "完全清晰，无任何大气效果" },
		{ value: "light_fog", desc: "轻微雾气，远处稍有衰减" },
		{ value: "heavy_fog", desc: "浓雾，近处也可见明显雾效" },
		{ value: "mist", desc: "薄雾，地面附近有轻纱感" },
		{ value: "haze", desc: "霾，远距离衰减但无体积感" },
		{ value: "storm", desc: "暴风雨/沙尘暴，极端天气效果" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	light_direction: [
		{ value: "front", desc: "主光从相机方向来（顺光）" },
		{ value: "side", desc: "主光从侧面来（侧光）" },
		{ value: "back", desc: "主光从被摄体后方来（逆光）" },
		{ value: "top", desc: "主光从正上方来（顶光）" },
		{ value: "ambient", desc: "无明显方向，全方向漫射" },
		{ value: "low_angle", desc: "主光以低角度射入（斜射）" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	mood: [
		{ value: "bright", desc: "明亮愉快" },
		{ value: "dark", desc: "黑暗沉重" },
		{ value: "moody", desc: "氛围感强，情绪化" },
		{ value: "vibrant", desc: "鲜艳活泼" },
		{ value: "muted", desc: "柔和低沉" },
		{ value: "dramatic", desc: "戏剧化，强对比" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
};

function buildTaggingPrompt() {
	let prompt = `你是一个游戏光照分析助手。

分析这张图片的光照氛围，返回结构化标签。

对以下 5 个维度，每个维度从列出的选项中选择最匹配的一个值。
如果所有选项都不符合图片特征，选择 "unspecified"。
你必须从列出的选项中选择——不要创造新值。

维度:
`;

	for (const dim of CONTROLLED_DIMENSIONS) {
		const values = getEffectiveVocabulary(dim);
		const descMap = TAG_DESCRIPTIONS[dim];
		prompt += `  ${dim}: [${values.join(", ")}]\n`;
		for (const entry of descMap) {
			if (values.includes(entry.value)) {
				prompt += `    - ${entry.value.padEnd(20)} — ${entry.desc}\n`;
			}
		}
		const customValues = values.filter((v) => !descMap.find((d) => d.value === v));
		for (const cv of customValues) {
			prompt += `    - ${cv.padEnd(20)} — (用户自定义标签)\n`;
		}
		prompt += "\n";
	}

	prompt += `此外:
  - description: 1-3 句自然语言描述该图的光照氛围
  - freeformTags: 0-5 个上述维度未覆盖的场景特征词
    (如 "ocean_horizon", "mountain_silhouette", "indoor", "god_rays")

返回纯 JSON（无 markdown 代码块）:

{
  "description": "Warm golden hour sunlight over ocean horizon...",
  "tags": { "time_of_day": "golden_hour", "color_palette": "warm" },
  "freeformTags": ["ocean_horizon", "god_rays"]
}`;

	return prompt;
}

// ═══════════════════════════════════════════
// Tests — getEffectiveVocabulary
// ═══════════════════════════════════════════

console.log("\n── getEffectiveVocabulary() ──\n");

(() => {
	_customVocabulary = {};
	const vocab = getEffectiveVocabulary("time_of_day");
	check("base only → includes golden_hour", vocab.includes("golden_hour"));
	check("base only → includes unspecified", vocab.includes("unspecified"));
	check("base only → count = 7", vocab.length === 7, `got ${vocab.length}`);
})();

(() => {
	_customVocabulary = { time_of_day: ["sunset", "twilight"] };
	const vocab = getEffectiveVocabulary("time_of_day");
	check("base+custom → includes golden_hour", vocab.includes("golden_hour"));
	check("base+custom → includes sunset", vocab.includes("sunset"));
	check("base+custom → includes twilight", vocab.includes("twilight"));
	check("base+custom → count = 9", vocab.length === 9, `got ${vocab.length}`);
})();

(() => {
	_customVocabulary = { time_of_day: ["golden_hour"] }; // duplicate
	const vocab = getEffectiveVocabulary("time_of_day");
	check("duplicate custom → no duplicates", vocab.filter((v) => v === "golden_hour").length === 1);
	check("duplicate custom → count still 7", vocab.length === 7, `got ${vocab.length}`);
})();

(() => {
	_customVocabulary = { time_of_day: ["sunset"] };
	const vocab = getEffectiveVocabulary("color_palette");
	check("custom on other dim → color_palette unaffected", vocab.length === 5 && vocab.includes("warm"));
})();

// ═══════════════════════════════════════════
// Tests — buildTaggingPrompt
// ═══════════════════════════════════════════

console.log("\n── buildTaggingPrompt() ──\n");

(() => {
	_customVocabulary = {};
	const prompt = buildTaggingPrompt();
	check("prompt → contains time_of_day header", prompt.includes("time_of_day"));
	check("prompt → contains color_palette header", prompt.includes("color_palette"));
	check("prompt → contains atmosphere header", prompt.includes("atmosphere"));
	check("prompt → contains light_direction header", prompt.includes("light_direction"));
	check("prompt → contains mood header", prompt.includes("mood"));
	check("prompt → contains base description", prompt.includes("温暖的倾斜低角度日光"));
	check("prompt → asks for JSON output", prompt.includes("返回纯 JSON"));
	check("prompt → contains freeformTags instruction", prompt.includes("freeformTags"));
	check("prompt → contains '不要创造新值'", prompt.includes("不要创造新值"));
})();

(() => {
	_customVocabulary = { time_of_day: ["sunset"] };
	const prompt = buildTaggingPrompt();
	check("prompt+custom → contains sunset", prompt.includes("sunset"));
	check("prompt+custom → sunset tagged as custom", prompt.includes("(用户自定义标签)"));
	check("prompt+custom → golden_hour still has Chinese desc", prompt.includes("温暖的倾斜低角度日光"));
})();

(() => {
	_customVocabulary = { time_of_day: ["sunset", "twilight", "magic_hour"] };
	const prompt = buildTaggingPrompt();
	const lines = prompt.split("\n");
	const customLines = lines.filter((l) => l.includes("(用户自定义标签)"));
	check("prompt+3custom → 3 custom labels", customLines.length === 3, `got ${customLines.length}`);
})();

// Reset
_customVocabulary = {};

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`${FAIL} ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`${PASS} All vocabulary + prompt tests passed!`);
}
