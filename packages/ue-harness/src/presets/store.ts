/**
 * Issue 008a — 预设磁盘存储 CRUD
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { PresetEntry } from "./types.ts";

let _presetsDir: string = join(homedir(), ".pi", "agent", "presets");

/** 覆盖预设目录（测试隔离用） */
export function _overridePresetsDir(path: string): void {
	_presetsDir = path;
}

function ensureDir(): void {
	if (!existsSync(_presetsDir)) {
		mkdirSync(_presetsDir, { recursive: true });
	}
}

/** 加载所有有效预设 */
export function loadAllPresets(): PresetEntry[] {
	ensureDir();
	const dirs = readdirSync(_presetsDir, { withFileTypes: true });
	const presets: PresetEntry[] = [];

	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		const entry = loadPresetEntry(d.name);
		if (entry) presets.push(entry);
	}

	return presets;
}

/** 加载单个预设 */
export function loadPresetEntry(name: string): PresetEntry | null {
	const jsonPath = join(_presetsDir, name, "preset.json");
	try {
		if (!existsSync(jsonPath)) return null;
		return JSON.parse(readFileSync(jsonPath, "utf-8")) as PresetEntry;
	} catch {
		return null;
	}
}

/** 保存预设条目（同时写 preset.json） */
export function savePresetEntry(entry: PresetEntry): void {
	ensureDir();
	const dir = join(_presetsDir, entry.name);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(dir, "preset.json"), JSON.stringify(entry, null, 2), "utf-8");
}

/** 删除整个预设子目录 */
export function deletePresetDir(name: string): void {
	const dir = join(_presetsDir, name);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** 检查预设目录是否存在 */
export function presetExists(name: string): boolean {
	return existsSync(join(_presetsDir, name, "preset.json"));
}

/** 查找哪些预设使用了某个维度的某个标签值 */
export function findPresetsByTagValue(
	dim: string,
	value: string,
): Array<{ name: string; currentTag: string }> {
	const all = loadAllPresets();
	return all
		.filter((p) => (p.tags as Record<string, string>)[dim] === value)
		.map((p) => ({ name: p.name, currentTag: (p.tags as Record<string, string>)[dim] }));
}

/** 获取预设目录路径（用于拷贝截图等操作） */
export function getPresetDir(name: string): string {
	return join(_presetsDir, name);
}

/** 列出所有预设名称（不加载完整数据） */
export function listPresetNames(): string[] {
	ensureDir();
	return readdirSync(_presetsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}
