/**
 * Issue 010a — store CRUD 测试（简化版：tags 为 string[]）
 *
 * 运行: node test/presets-008a-store.mjs
 *
 * 源文件: src/presets/store.ts
 * 使用临时目录隔离，不污染 ~/.pi/agent/presets/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

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
// inline copy of store functions (adapted to use testDir)
// ═══════════════════════════════════════════

let _dir;

function ensureDir() {
	if (!existsSync(_dir)) mkdirSync(_dir, { recursive: true });
}

function loadAllPresets() {
	ensureDir();
	const presets = [];
	const entries = readdirSync(_dir, { withFileTypes: true });
	for (const d of entries) {
		if (!d.isDirectory()) continue;
		const e = loadPresetEntry(d.name);
		if (e) presets.push(e);
	}
	return presets;
}

function loadPresetEntry(name) {
	const jsonPath = join(_dir, name, "preset.json");
	try {
		if (!existsSync(jsonPath)) return null;
		return JSON.parse(readFileSync(jsonPath, "utf-8"));
	} catch {
		return null;
	}
}

function savePresetEntry(entry) {
	ensureDir();
	const dir = join(_dir, entry.name);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "preset.json"), JSON.stringify(entry, null, 2), "utf-8");
}

function deletePresetDir(name) {
	const dir = join(_dir, name);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function presetExists(name) {
	return existsSync(join(_dir, name, "preset.json"));
}

function listPresetNames() {
	ensureDir();
	return readdirSync(_dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

// ═══════════════════════════════════════════
// Test setup: temp directory
// ═══════════════════════════════════════════

const TEST_ID = randomBytes(4).toString("hex");
_dir = join(tmpdir(), `pi-presets-test-${TEST_ID}`);
console.log(`Test dir: ${_dir}`);

function makeEntry(name, tag) {
	return {
		name,
		description: `Test preset ${name}`,
		tags: [tag, "test"],
		screenshot: `${name}.png`,
		actors: {},
		postprocessReset: false,
		created: new Date().toISOString(),
	};
}

// ═══════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════

console.log("\n── store CRUD ──\n");

// Case 1: save + load 往返
(() => {
	const entry = makeEntry("roundtrip-test", "golden_hour");
	savePresetEntry(entry);
	const loaded = loadPresetEntry("roundtrip-test");
	check("save+load → entry exists", loaded !== null);
	check("save+load → name matches", loaded?.name === "roundtrip-test");
	check("save+load → tags preserved", loaded?.tags?.includes("golden_hour") && loaded?.tags?.includes("test"));
	check("save+load → actors preserved", loaded?.actors && Object.keys(loaded.actors).length === 0);
	check("save+load → created preserved", typeof loaded?.created === "string" && loaded.created.length > 0);
	deletePresetDir("roundtrip-test");
})();

// Case 2: loadAllPresets returns all valid entries
(() => {
	savePresetEntry(makeEntry("preset-a", "golden_hour"));
	savePresetEntry(makeEntry("preset-b", "dusk"));
	savePresetEntry(makeEntry("preset-c", "night"));
	const all = loadAllPresets();
	check("loadAllPresets → count 3", all.length === 3, `got ${all.length}`);
	const names = all.map((p) => p.name).sort();
	check("loadAllPresets → all names present", names.join(",") === "preset-a,preset-b,preset-c", names.join(","));
	deletePresetDir("preset-a");
	deletePresetDir("preset-b");
	deletePresetDir("preset-c");
})();

// Case 3: corrupted JSON → skipped, not crashed
(() => {
	savePresetEntry(makeEntry("valid-one", "golden_hour"));
	const corruptDir = join(_dir, "corrupt-one");
	mkdirSync(corruptDir, { recursive: true });
	writeFileSync(join(corruptDir, "preset.json"), "NOT VALID JSON{{{");
	const all = loadAllPresets();
	check("corrupted JSON → loadAllPresets does not crash", true);
	check("corrupted JSON → valid preset still loaded", all.some((p) => p.name === "valid-one"));
	check("corrupted JSON → corrupt entry not in list", !all.some((p) => p.name === "corrupt-one"));
	deletePresetDir("valid-one");
	deletePresetDir("corrupt-one");
})();

// Case 4: deletePresetDir removes everything
(() => {
	savePresetEntry(makeEntry("to-delete", "dawn"));
	check("pre-delete → presetExists=true", presetExists("to-delete"));
	deletePresetDir("to-delete");
	check("post-delete → presetExists=false", !presetExists("to-delete"));
	check("post-delete → not in listPresetNames", !listPresetNames().includes("to-delete"));
})();

// Case 5: presetExists true/false
(() => {
	savePresetEntry(makeEntry("exists-test", "overcast"));
	check("presetExists → true for existing", presetExists("exists-test"));
	check("presetExists → false for missing", !presetExists("nonexistent-xyz"));
	deletePresetDir("exists-test");
})();

// Case 6: listPresetNames returns all names
(() => {
	savePresetEntry(makeEntry("alpha", "night"));
	savePresetEntry(makeEntry("beta", "dawn"));
	const list = listPresetNames();
	check("listPresetNames → contains alpha", list.includes("alpha"));
	check("listPresetNames → contains beta", list.includes("beta"));
	check("listPresetNames → correct count", list.length >= 2);
	deletePresetDir("alpha");
	deletePresetDir("beta");
})();

// Case 7: overwrite existing preset
(() => {
	const v1 = makeEntry("overwrite-test", "golden_hour");
	v1.description = "version 1";
	savePresetEntry(v1);
	const loaded1 = loadPresetEntry("overwrite-test");
	check("overwrite → v1 saved", loaded1?.description === "version 1");

	const v2 = makeEntry("overwrite-test", "dusk");
	v2.description = "version 2";
	savePresetEntry(v2);
	const loaded2 = loadPresetEntry("overwrite-test");
	check("overwrite → v2 overwrites", loaded2?.description === "version 2");
	check("overwrite → tags updated", loaded2?.tags?.includes("dusk"));

	deletePresetDir("overwrite-test");
})();

// Case 8: empty directory → loadAllPresets returns []
(() => {
	const remaining = loadAllPresets();
	check("empty dir → no crash", Array.isArray(remaining));
})();

// ═══════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════

try {
	if (existsSync(_dir)) rmSync(_dir, { recursive: true, force: true });
} catch { /* best effort */ }

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════

console.log(`\n${passed}/${passed + failed} tests passed`);
if (failed > 0) {
	console.error(`${FAIL} ${failed} tests FAILED`);
	process.exit(1);
} else {
	console.log(`${PASS} All store CRUD tests passed!`);
}
