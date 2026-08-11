# Issue 008a — 基础：标签分析器 + 类型 + 存储

**状态**: 待开工
**依赖**: Issue 003-005 已完成（`VisionClient.sendAndParse<T>()`、`captureViewport()` 可用）
**预计**: 1.5 天
**PRD**: [docs/issue-008-preset-system.md](../../issue-008-preset-system.md)

---

## 1. 目标

建立预设系统的三个基础模块：Vision 标签分析器（可复用）、类型定义（全系统引用）、磁盘存储（CRUD）。

---

## 2. 依赖

- 已有 `VisionClient.sendAndParse<T>()` in `vision/vision-client.ts`
- 已有 `state.ts` 的 `getVisionClient()` / `getUeClient()` 模式

---

## 3. 产出文件

| 文件 | 操作 | 内容 |
|------|:--:|------|
| `packages/ue-harness/src/vision/analyzer.ts` | N | 标签类型、词汇表、校验、`analyzeAndTag()` |
| `packages/ue-harness/src/vision/prompts.ts` | E | 新增 `buildTaggingPrompt()` |
| `packages/ue-harness/src/presets/types.ts` | N | `PresetEntry`, `PresetActor`, `PresetMatch` |
| `packages/ue-harness/src/presets/store.ts` | N | `loadAllPresets()`, `savePresetEntry()`, `loadPresetEntry()`, `deletePresetDir()`, `findPresetsByTagValue()` |

---

## 4. 详细规格

### 4.1 `vision/analyzer.ts` — 完整实现

```typescript
/**
 * Issue 008a — Vision 标签分析器
 *
 * 将图片（base64）通过 Vision API 转换为结构化标签。
 * 是"分析图片 → 生成标签"的唯一入口——被参考图分析和预设保存复用。
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { buildTaggingPrompt } from "./prompts.ts";
import type { VisionClient } from "./vision-client.ts";

// ═══════════════════════════════════════════
// 编译时基础词汇表
// ═══════════════════════════════════════════

export const BASE_TAG_VALUES = {
  time_of_day:     ["golden_hour", "midday", "dusk", "night", "dawn", "overcast", "unspecified"],
  color_palette:   ["warm", "cool", "neutral", "warm_cool_contrast", "unspecified"],
  atmosphere:      ["clear", "light_fog", "heavy_fog", "mist", "haze", "storm", "unspecified"],
  light_direction: ["front", "side", "back", "top", "ambient", "low_angle", "unspecified"],
  mood:            ["bright", "dark", "moody", "vibrant", "muted", "dramatic", "unspecified"],
} as const;

export type ControlledTagDimension = keyof typeof BASE_TAG_VALUES;

export const CONTROLLED_DIMENSIONS: ControlledTagDimension[] = [
  "time_of_day", "color_palette", "atmosphere", "light_direction", "mood",
];

// ═══════════════════════════════════════════
// 运行时扩展词汇表
// ═══════════════════════════════════════════

const VOCABULARY_PATH = join(homedir(), ".pi", "agent", "tag-vocabulary.json");
const ALIASES_PATH = join(homedir(), ".pi", "agent", "tag-aliases.json");

let _customVocabulary: Record<string, string[]> = {};
let _aliases: Record<string, Record<string, string>> = {};

/** session_start 时调用：从磁盘加载自定义词汇和别名 */
export function loadCustomVocabulary(): void {
  try {
    if (existsSync(VOCABULARY_PATH)) {
      _customVocabulary = JSON.parse(readFileSync(VOCABULARY_PATH, "utf-8"));
    }
  } catch { /* 文件不存在或损坏 → 保持空，不报错 */ }

  try {
    if (existsSync(ALIASES_PATH)) {
      _aliases = JSON.parse(readFileSync(ALIASES_PATH, "utf-8"));
    }
  } catch { /* 同上 */ }
}

function writeVocabularyFile(): void {
  const dir = join(homedir(), ".pi", "agent");
  if (!existsSync(dir)) {
    // mkdir 在 Node.js 中: import { mkdirSync } from "fs"; mkdirSync(dir, { recursive: true });
  }
  writeFileSync(VOCABULARY_PATH, JSON.stringify(_customVocabulary, null, 2), "utf-8");
}

/** 获取合并后的有效词汇表（基础 + 自定义） */
export function getEffectiveVocabulary(dim: ControlledTagDimension): string[] {
  const base = [...BASE_TAG_VALUES[dim]];
  const custom = _customVocabulary[dim] ?? [];
  return [...new Set([...base, ...custom])];
}

/** 运行时校验标签值是否合法 */
export function isValidTagValue(dim: ControlledTagDimension, value: string): boolean {
  return getEffectiveVocabulary(dim).includes(value);
}

/** 运行时新增自定义标签（008f approve_tag 调用） */
export function addCustomTag(dim: ControlledTagDimension, value: string): void {
  if (!_customVocabulary[dim]) _customVocabulary[dim] = [];
  if (!_customVocabulary[dim].includes(value)) {
    _customVocabulary[dim].push(value);
    writeVocabularyFile();
  }
}

// ═══════════════════════════════════════════
// 类型（宽松 string，运行时校验保底）
// ═══════════════════════════════════════════

export interface PresetTags {
  time_of_day: string;
  color_palette: string;
  atmosphere: string;
  light_direction: string;
  mood: string;
}

export interface TagValidation {
  isValid: boolean;
  unknownTags: Array<{ dimension: ControlledTagDimension; value: string }>;
}

export interface TagResult {
  description: string;
  tags: PresetTags;
  freeformTags: string[];
  validation: TagValidation;
}

// ═══════════════════════════════════════════
// 别名映射
// ═══════════════════════════════════════════

function applyAlias(dim: ControlledTagDimension, rawValue: string): string | null {
  return _aliases[dim]?.[rawValue] ?? null;
}

// ═══════════════════════════════════════════
// 校验
// ═══════════════════════════════════════════

function validateTags(raw: Record<string, unknown>): TagResult {
  const tags: PresetTags = {
    time_of_day: "unspecified", color_palette: "unspecified",
    atmosphere: "unspecified", light_direction: "unspecified", mood: "unspecified",
  };
  const unknownTags: TagValidation["unknownTags"] = [];

  for (const dim of CONTROLLED_DIMENSIONS) {
    const rawValue = String(raw[dim] ?? "unspecified");

    // Step 1: 别名映射
    const aliased = applyAlias(dim, rawValue);
    if (aliased && isValidTagValue(dim, aliased)) {
      tags[dim] = aliased;
      continue;
    }

    // Step 2: 直接合法
    if (isValidTagValue(dim, rawValue)) {
      tags[dim] = rawValue;
      continue;
    }

    // Step 3: 未知值 → 降级 + 记录
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
// 主入口
// ═══════════════════════════════════════════

/**
 * 分析单张图片，返回结构化标签。
 * 被以下场景复用:
 *   - 参考图分析（assess_lighting 流程中并行调用）
 *   - 预设保存（save_preset 流程中分析截图）
 *   - 预设重分析（008f reanalyze_preset）
 */
export async function analyzeAndTag(
  visionClient: VisionClient,
  imageBase64: string,
): Promise<TagResult> {
  const raw = await visionClient.sendAndParse<Record<string, unknown>>({
    prompt: buildTaggingPrompt(),
    images: [{ base64: imageBase64 }],
  });
  return validateTags(raw);
}
```

### 4.2 `vision/prompts.ts` — 新增函数

在文件末尾添加（不改动已有常量）：

```typescript
// vision/prompts.ts — 追加内容

import { CONTROLLED_DIMENSIONS, getEffectiveVocabulary, type ControlledTagDimension } from "./analyzer.ts";

/** 基础标签值的中文描述映射（仅基础值有描述，自定义值只列出英文名） */
const TAG_DESCRIPTIONS: Record<ControlledTagDimension, Array<{ value: string; desc: string }>> = {
  time_of_day: [
    { value: "golden_hour",  desc: "温暖的倾斜低角度日光，长阴影，橙/金色调" },
    { value: "midday",       desc: "明亮的顶光，短阴影，中性白光" },
    { value: "dusk",         desc: "黄昏，太阳低于地平线但天空仍有色彩，紫/粉色调" },
    { value: "night",        desc: "夜晚场景，月光或人造光源照明" },
    { value: "dawn",         desc: "清晨，冷调淡色，太阳接近地平线" },
    { value: "overcast",     desc: "阴天漫射光，无明确太阳方向，灰调天空感" },
    { value: "unspecified",  desc: "以上皆不符合" },
  ],
  color_palette: [
    { value: "warm",                desc: "全局暖调（橙/金色）" },
    { value: "cool",                desc: "全局冷调（蓝/白）" },
    { value: "neutral",             desc: "自然中性色调" },
    { value: "warm_cool_contrast",  desc: "画面不同区域有明显色温差异（暖高光 + 冷阴影）" },
    { value: "unspecified",         desc: "以上皆不符合" },
  ],
  atmosphere: [
    { value: "clear",       desc: "完全清晰，无任何大气效果" },
    { value: "light_fog",   desc: "轻微雾气，远处稍有衰减" },
    { value: "heavy_fog",   desc: "浓雾，近处也可见明显雾效" },
    { value: "mist",        desc: "薄雾，地面附近有轻纱感" },
    { value: "haze",        desc: "霾，远距离衰减但无体积感" },
    { value: "storm",       desc: "暴风雨/沙尘暴，极端天气效果" },
    { value: "unspecified", desc: "以上皆不符合" },
  ],
  light_direction: [
    { value: "front",       desc: "主光从相机方向来（顺光）" },
    { value: "side",        desc: "主光从侧面来（侧光）" },
    { value: "back",        desc: "主光从被摄体后方来（逆光）" },
    { value: "top",         desc: "主光从正上方来（顶光）" },
    { value: "ambient",     desc: "无明显方向，全方向漫射" },
    { value: "low_angle",   desc: "主光以低角度射入（斜射）" },
    { value: "unspecified", desc: "以上皆不符合" },
  ],
  mood: [
    { value: "bright",        desc: "明亮愉快" },
    { value: "dark",          desc: "黑暗沉重" },
    { value: "moody",         desc: "氛围感强，情绪化" },
    { value: "vibrant",       desc: "鲜艳活泼" },
    { value: "muted",         desc: "柔和低沉" },
    { value: "dramatic",      desc: "戏剧化，强对比" },
    { value: "unspecified",   desc: "以上皆不符合" },
  ],
};

/** 动态生成标签分析 prompt，自动纳入最新的有效词汇表 */
export function buildTaggingPrompt(): string {
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
    // 自定义值（无中文描述）
    const customValues = values.filter(v => !descMap.find(d => d.value === v));
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
  "tags": { "time_of_day": "golden_hour", "color_palette": "warm", ... },
  "freeformTags": ["ocean_horizon", "god_rays"]
}`;

  return prompt;
}
```

### 4.3 `presets/types.ts` — 完整实现

```typescript
/**
 * Issue 008a — 预设系统类型定义
 */

import type { PresetTags } from "../vision/analyzer.ts";

/** 单个 actor 的属性快照 */
export interface PresetActor {
  /** UE 中该 actor 的完整 refPath */
  refPath: string;
  /** DirectionalLight 的 transform（旋转），其他组件无此字段 */
  transform?: { rotation: { Pitch: number; Yaw: number; Roll: number } };
  /** 组件 → 属性键值对 */
  components: Record<string, Record<string, unknown>>;
}

/** 预设条目（存储于 preset.json） */
export interface PresetEntry {
  name: string;
  description: string;            // Vision 自动生成的自然语言描述
  tags: PresetTags;               // 受控标签（5 维度，用于匹配）
  freeformTags: string[];         // 自由标签（加分项）
  screenshot: string;             // 截图文件名（相对预设目录）
  actors: Record<string, PresetActor>;
  postprocessReset: boolean;
  created: string;                // ISO 8601
}

/** 预设匹配结果 */
export interface PresetMatch {
  name: string;
  description: string;
  score: number;                  // 0-1
  matchedDimensions: string[];    // 具体哪些受控标签匹配
}
```

### 4.4 `presets/store.ts` — 完整实现

```typescript
/**
 * Issue 008a — 预设磁盘存储 CRUD
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PresetEntry } from "./types.ts";

const PRESETS_DIR = join(homedir(), ".pi", "agent", "presets");

function ensureDir(): void {
  if (!existsSync(PRESETS_DIR)) {
    mkdirSync(PRESETS_DIR, { recursive: true });
  }
}

/** 加载所有有效预设 */
export function loadAllPresets(): PresetEntry[] {
  ensureDir();
  const dirs = readdirSync(PRESETS_DIR, { withFileTypes: true });
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
  const jsonPath = join(PRESETS_DIR, name, "preset.json");
  try {
    if (!existsSync(jsonPath)) return null;
    return JSON.parse(readFileSync(jsonPath, "utf-8")) as PresetEntry;
  } catch {
    // JSON 损坏 → 跳过，list_presets 可标记为 corrupted
    return null;
  }
}

/** 保存预设条目（同时写 preset.json） */
export function savePresetEntry(entry: PresetEntry): void {
  ensureDir();
  const dir = join(PRESETS_DIR, entry.name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(dir, "preset.json"),
    JSON.stringify(entry, null, 2),
    "utf-8",
  );
}

/** 删除整个预设子目录 */
export function deletePresetDir(name: string): void {
  const dir = join(PRESETS_DIR, name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 检查预设目录是否存在 */
export function presetExists(name: string): boolean {
  return existsSync(join(PRESETS_DIR, name, "preset.json"));
}

/** 查找哪些预设使用了某个维度的某个标签值（008f affected_presets 用） */
export function findPresetsByTagValue(
  dim: string,
  value: string,
): Array<{ name: string; currentTag: string }> {
  const all = loadAllPresets();
  return all
    .filter(p => (p.tags as Record<string, string>)[dim] === value)
    .map(p => ({ name: p.name, currentTag: (p.tags as Record<string, string>)[dim] }));
}

/** 获取预设目录路径（用于拷贝截图等操作） */
export function getPresetDir(name: string): string {
  return join(PRESETS_DIR, name);
}

/** 列出所有预设名称（不加载完整数据） */
export function listPresetNames(): string[] {
  ensureDir();
  return readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}
```

---

## 5. 边界条件

| 场景 | 处理 |
|------|------|
| `tag-vocabulary.json` 不存在 | `loadCustomVocabulary()` 保持 `_customVocabulary = {}`，不报错 |
| `tag-aliases.json` 不存在 | `loadCustomVocabulary()` 保持 `_aliases = {}`，不报错 |
| Vision 返回缺少字段 | `validateTags()` 对缺失维度补 `"unspecified"` |
| Vision 返回非法标签值 | 走别名 → 降级 unspecified → 记录到 `validation.unknownTags` |
| `freeformTags` 不是数组 | 降级为 `[]` |
| `~/.pi/agent/presets/` 不存在 | 首次 `loadAllPresets()` 时自动创建 |
| 预设 JSON 损坏 | `loadPresetEntry()` 返回 `null`，不抛异常 |
| 预设名称含特殊字符（如 `../`） | `store.ts` 不做路径安全检查——当前版本假设预设名由 LLM 生成，不含路径穿越字符 |

---

## 6. 独立测试

### 6.1 `validateTags()` — 纯函数，完全可测

测试文件：`packages/ue-harness/test/presets-validation.test.ts`

```typescript
// 测试用例：

// Case 1: 全部合法值
//   输入: { time_of_day: "golden_hour", color_palette: "warm", atmosphere: "clear",
//           light_direction: "low_angle", mood: "dramatic", description: "...", freeformTags: ["ocean"] }
//   预期: validation.isValid === true, validation.unknownTags === []
//         tags 各维度值不变

// Case 2: 一个非法值
//   输入: { time_of_day: "sunset", color_palette: "warm", ... }
//   预期: validation.isValid === false
//         validation.unknownTags === [{ dimension: "time_of_day", value: "sunset" }]
//         tags.time_of_day === "unspecified"（降级）
//         其他维度不变

// Case 3: 别名映射命中
//   前提: tag-aliases.json 含 { "time_of_day": { "sunset": "golden_hour" } }
//   输入: { time_of_day: "sunset", ... }
//   预期: tags.time_of_day === "golden_hour"（通过别名转为合法值）
//         validation.isValid === true

// Case 4: 别名映射未命中 → 降级
//   前提: 无匹配别名
//   输入: { time_of_day: "nonexistent_xyz", ... }
//   预期: tags.time_of_day === "unspecified"
//         validation.unknownTags 包含该值

// Case 5: 缺少维度
//   输入: { color_palette: "warm" }（缺 time_of_day 等）
//   预期: 缺失维度补 "unspecified", validation.isValid === true

// Case 6: freeformTags 不是数组
//   输入: { ..., freeformTags: "not_an_array" }
//   预期: freeformTags 降级为 []

// Case 7: 多个维度同时非法
//   输入: { time_of_day: "sunset", mood: "rainbow" }
//   预期: validation.unknownTags 长度 === 2, 两个维度均降级为 "unspecified"
```

### 6.2 `getEffectiveVocabulary()` — 可测（状态隔离）

测试文件：`packages/ue-harness/test/presets-vocabulary.test.ts`

```typescript
// Case 1: 仅基础词汇（_customVocabulary 为空）
//   getEffectiveVocabulary("time_of_day") → 等于 BASE_TAG_VALUES.time_of_day

// Case 2: 基础 + 自定义合并
//   手动设置 _customVocabulary = { time_of_day: ["sunset", "twilight"] }
//   getEffectiveVocabulary("time_of_day") → 包含 golden_hour, sunset, twilight, unspecified 等
//   基础值不去重，自定义值追加，Set 去重保证无重复

// Case 3: 自定义值已存在于基础中
//   _customVocabulary = { time_of_day: ["golden_hour"] }
//   getEffectiveVocabulary("time_of_day") → golden_hour 不出现两次
```

**注意**：`_customVocabulary` 是模块私有变量。测试需在 `analyzer.ts` 中导出 `_resetForTest()` 函数（仅测试环境使用）来隔离状态，或在每个测试前后手动重置。

### 6.3 `buildTaggingPrompt()` — 纯函数，可测

```typescript
// Case 1: prompt 包含所有 5 维度的基础值名称
//   buildTaggingPrompt() → 包含 "time_of_day", "color_palette", "atmosphere",
//     "light_direction", "mood" 五个标题

// Case 2: prompt 包含基础值的中文描述
//   buildTaggingPrompt() → 包含 "温暖的倾斜低角度日光"（golden_hour 的描述）

// Case 3: 自定义值出现在 prompt 中
//   手动 _customVocabulary = { time_of_day: ["sunset"] }
//   buildTaggingPrompt() → 包含 "sunset" 且标注 "(用户自定义标签)"

// Case 4: prompt 不出现不在词汇表中的值
//   buildTaggingPrompt() → 不包含任意自由文本（结构固定）
```

### 6.4 Store 函数 — 文件 I/O，可用 tmp 目录测试

测试文件：`packages/ue-harness/test/presets-store.test.ts`

```typescript
// 每个测试在独立 temp 目录中执行（如 /tmp/pi-presets-test-xxxxx/）

// Case 1: savePresetEntry + loadPresetEntry 往返
//   构造 PresetEntry → savePresetEntry(entry) → loadPresetEntry(name)
//   → 返回的 entry 字段与原始完全一致（深度比较）

// Case 2: loadAllPresets 返回多条目
//   创建 3 个预设 → loadAllPresets() → length === 3
//   按名称排序

// Case 3: 损坏 JSON 被跳过
//   手动在预设目录写一个非 JSON 文件 → loadAllPresets() 不崩溃，不包含该条目

// Case 4: deletePresetDir 完整删除
//   创建预设 → deletePresetDir(name) → presetExists(name) === false

// Case 5: presetExists 真假
//   不存在的名称 → false; 刚创建的名称 → true

// Case 6: findPresetsByTagValue 匹配
//   创建 3 个预设，其中 2 个 time_of_day="golden_hour"
//   findPresetsByTagValue("time_of_day", "golden_hour") → length === 2
//   findPresetsByTagValue("time_of_day", "night") → length === 1
```

**注意**：store 函数使用 `homedir()` 拼接路径。测试时需通过环境变量或模块注入覆盖 `PRESETS_DIR`。建议在 `store.ts` 中暴露 `_overridePresetsDir(path: string)` 供测试使用。

### 6.5 跳过项

| 函数 | 原因 |
|------|------|
| `analyzeAndTag()` | 依赖 Vision API（需网络 + API key），逻辑核心已在 `validateTags()` 中覆盖 |
| `loadCustomVocabulary()` | 文件 I/O 简单封装，`loadAllPresets` 的测试间接覆盖 |
| `addCustomTag()` + `writeVocabularyFile()` | 文件写入简单封装，逻辑在 `getEffectiveVocabulary` 测试中覆盖 |
| 类型定义（`PresetTags`, `TagResult` 等） | TypeScript 编译期验证，无需运行时测试 |

---

## 7. 验收标准

1. `analyzeAndTag()` 能调用 Vision API 并返回 `TagResult`，`validation.isValid === true`
2. 对已知非法值（如 `time_of_day: "sunset"`），`validation.unknownTags` 记录该值，`tags.time_of_day` 降级为 `"unspecified"`
3. `buildTaggingPrompt()` 生成的 prompt 包含所有 5 个维度的选项列表，且从 `getEffectiveVocabulary()` 读取
4. `loadAllPresets()` 正确遍历 `~/.pi/agent/presets/` 子目录，跳过损坏的 JSON
5. `savePresetEntry()` → `loadPresetEntry()` 往返一致
6. `deletePresetDir()` 完整删除子目录

---

## 8. 与后续 Issue 的接口

本 Issue 产出以下元素供后续 Issue 导入使用：

| 元素 | 后续使用者 |
|------|------|
| `analyzeAndTag()` | 008b（save_preset 截图分析）, 008c（参考图分析）, 008f（reanalyze_preset） |
| `PresetTags` 类型 | 008b（types 引用）, 008c（match 算法入参） |
| `TagResult` 类型 | 008b, 008c |
| `TagValidation` 类型 | 008f（guard rules 判断触发条件） |
| `BASE_TAG_VALUES` | 008a（自身）, 008c（match 遍历维度） |
| `CONTROLLED_DIMENSIONS` | 008c（match 遍历维度） |
| `getEffectiveVocabulary()` | 008f（approve_tag 后验证新标签是否生效） |
| `isValidTagValue()` | 008f（guard 判断是否需要 TAG_REVIEW） |
| `loadCustomVocabulary()` | index.ts（session_start 调用） |
| `addCustomTag()` | 008f（approve_tag） |
| `PresetEntry` | 008b（capture）, 008c（match 入参）, 008d（apply 入参） |
| `PresetMatch` | 008c（match 返回值）, 008c（injections） |
| `PresetActor` | 008b（capture）, 008d（apply） |
| `loadAllPresets()` | 008c（match）, 008b（list_presets） |
| `savePresetEntry()` | 008b（save_preset） |
| `loadPresetEntry()` | 008d（load_preset） |
| `deletePresetDir()` | 008b（delete_preset） |
| `presetExists()` | 008b（save_preset 同名检测） |
| `findPresetsByTagValue()` | 008f（approve_tag affected_presets） |
| `getPresetDir()` | 008b（截图拷贝） |
