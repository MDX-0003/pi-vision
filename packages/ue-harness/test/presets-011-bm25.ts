/**
 * Issue 011 — BM25Index 单元测试
 *
 * 运行: node --import tsx test/presets-011-bm25.ts
 */
import { BM25Index } from "../src/presets/bm25.ts";
import type { PresetEntry } from "../src/presets/types.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`);
		passed++;
	} else {
		console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

function makePreset(name: string, description: string, tags: string[]): PresetEntry {
	return {
		name,
		description,
		tags,
		screenshot: "",
		actors: {},
		created: "",
	};
}

const query = (text: string) => ({ description: text, tags: [] as string[] });

// ── 建索引 + 打分 ──

console.log("\n── BM25 基础 ──\n");

(() => {
	const idx = new BM25Index();
	const presets = [
		makePreset("ocean", "golden hour sunset over ocean horizon", ["golden_hour", "ocean"]),
		makePreset("forest", "dark forest night cold blue", ["night", "forest"]),
	];
	idx.buildIndex(presets);

	const oceanScore = idx.score(query("golden sunset ocean"), presets[0]);
	const forestScore = idx.score(query("golden sunset ocean"), presets[1]);
	check("相关文档分数 > 不相关", oceanScore > forestScore, `ocean=${oceanScore.toFixed(3)}, forest=${forestScore.toFixed(3)}`);
	check("相关文档分数 > 0", oceanScore > 0);
})();

(() => {
	const idx = new BM25Index();
	idx.buildIndex([]);
	check("空索引 → 分数 0", idx.score(query("anything"), makePreset("x", "", [])) === 0);
})();

(() => {
	const idx = new BM25Index();
	const presets = [makePreset("a", "golden hour", [])];
	idx.buildIndex(presets);
	check("空 query → 分数 0", idx.score({ description: "", tags: [] }, presets[0]) === 0);
})();

// ── 词频影响 ──

(() => {
	const idx = new BM25Index();
	const presets = [
		makePreset("repeat", "golden golden golden golden", []),
		makePreset("once", "golden", []),
	];
	idx.buildIndex(presets);

	const repeatScore = idx.score(query("golden"), presets[0]);
	const onceScore = idx.score(query("golden"), presets[1]);
	check("词频高 → 分数高", repeatScore > onceScore, `repeat=${repeatScore.toFixed(3)}, once=${onceScore.toFixed(3)}`);
})();

// ── tags 参与索引 ──

(() => {
	const idx = new BM25Index();
	const presets = [
		makePreset("tagged", "", ["god_rays"]),
		makePreset("untagged", "", ["forest"]),
	];
	idx.buildIndex(presets);

	const taggedScore = idx.score(query("god rays"), presets[0]);
	const untaggedScore = idx.score(query("god rays"), presets[1]);
	check("tags 参与索引 → 命中 tag 的分数高", taggedScore > untaggedScore);
})();

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`${FAIL} ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`${PASS} All bm25 tests passed!`);
}
