/**
 * Issue 011 — matchPresets（RRF 混合检索）单元测试
 *
 * 运行: node --import tsx test/presets-011-match.ts
 */
import { jaccardScorer, matchPresets } from "../src/presets/match.ts";
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
	return { name, description, tags, screenshot: "", actors: {}, created: "" };
}

// ── jaccardScorer ──

console.log("\n── jaccardScorer() ──\n");

(() => {
	const q = { tags: ["a", "b"], description: "" };
	check("identical → 1.0", jaccardScorer(q, makePreset("x", "", ["a", "b"])) === 1);
	check("half overlap → 0.33", Math.abs(jaccardScorer(q, makePreset("x", "", ["a", "c"])) - 1 / 3) < 1e-9);
	check("no overlap → 0", jaccardScorer(q, makePreset("x", "", ["c", "d"])) === 0);
	check("empty tags → 0", jaccardScorer({ tags: [], description: "" }, makePreset("x", "", [])) === 0);
})();

// ── matchPresets：单 scorer（纯 Jaccard）──

console.log("\n── matchPresets() 单 scorer ──\n");

(async () => {
	// 三个 preset，与 query 的重叠度递减
	const presets = [
		makePreset("best", "", ["golden_hour", "warm", "ocean"]),
		makePreset("mid", "", ["golden_hour", "cool"]),
		makePreset("worst", "", ["forest", "night"]),
	];
	const query = { tags: ["golden_hour", "warm", "ocean"], description: "" };

	const results = await matchPresets(query, presets);
	check("返回按 score 降序", results[0].name === "best" && results[1].name === "mid", `got ${results.map((r) => r.name).join(", ")}`);
	check("完全匹配 score = 1", results[0].score === 1, `score=${results[0].score}`);
	check("topN 默认 5，3 个候选全返回", results.length === 3);
})();

(async () => {
	// topN 截断
	const presets = Array.from({ length: 10 }, (_, i) => makePreset(`p-${i}`, "", ["common"]));
	const results = await matchPresets({ tags: ["common"], description: "" }, presets, {}, { topN: 3 });
	check("topN=3 截断", results.length === 3, `got ${results.length}`);
})();

// ── matchPresets：双 scorer（Jaccard + BM25）RRF 融合 ──

console.log("\n── matchPresets() RRF 融合 ──\n");

(async () => {
	// 构造场景：query 语义上匹配 "sunset"，但标签上匹配 "forest"
	// preset A: 标签命中 forest，但描述是 forest（语义不匹配 sunset）
	// preset B: 标签不命中，但描述是 sunset（语义匹配）
	const presets = [
		makePreset("forest-tag", "dark forest night", ["forest"]),
		makePreset("sunset-desc", "golden sunset over ocean", ["beach"]),
	];
	const query = { tags: ["sunset"], description: "golden sunset over ocean" };

	const bm25 = new BM25Index();
	bm25.buildIndex(presets);

	const results = await matchPresets(query, presets, { bm25 });
	// BM25 会把 "sunset-desc" 排到前面（描述匹配），Jaccard 会把 "forest-tag" 排到前面（标签匹配）
	// RRF 融合后，取决于哪个 scorer 权重更大。这里验证：融合后仍返回 2 个结果，且顺序确定。
	check("融合后返回全部候选", results.length === 2);
	check("融合后 score 降序", results[0].score >= results[1].score);
	// sunset-desc 在 BM25 上 rank=1，在 jaccard 上 rank=2（forest-tag 标签命中 sunset？不，query tags=["sunset"]）
	// forest-tag: jaccard=0（forest vs sunset），bm25 低
	// sunset-desc: jaccard=0（beach vs sunset），bm25 高
	// 所以 sunset-desc 应该在前面
	check("语义匹配的 preset 排前", results[0].name === "sunset-desc", `got ${results[0].name}`);
})();

(async () => {
	// 空 preset 库
	const results = await matchPresets({ tags: ["a"], description: "" }, []);
	check("空 preset 库 → 空结果", results.length === 0);
})();

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`${FAIL} ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`${PASS} All match tests passed!`);
}
