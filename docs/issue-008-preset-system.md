# Issue 008 — 预设系统设计（v2，基于标签匹配）

**状态**: 设计中
**优先级**: P1
**依赖**: Issue 003-005 已完成（需要 `assess_lighting` + `captureViewport` + `set_properties`）
**上一版**: [handoff/0810-preset-system-design.md](handoff/0810-preset-system-design.md)（已废弃，本文件替代）
**预计时长**: 5-7 天（008a-008e）+ 2 天（008f，远期）

---

## 1. 动机

当前每次输入参考图，LLM 都需要从默认场景状态开始，经历 SETUP → TUNING 的完整流程。之前调好的参数经验被丢弃。

预设系统让 LLM 把"调好的参数 + 当前截图 + 结构化标签"保存为预设。下次遇到氛围相似的参考图时，自动匹配已有预设并建议 LLM 加载。

### 1.1 v2 相比 v1 的核心变更

| 方面 | v1（旧） | v2（新） | 原因 |
|------|---------|---------|------|
| 预设的视觉 ground truth | 参考图副本 | **当前截图** | 预设应自包含——"调成了什么样"而非"曾经参照了什么" |
| 参考图是否保留 | 拷贝到预设目录 | **不保留** | 截图即 ground truth，参考图使命结束即丢弃 |
| 匹配方式 | 自由文本 BM25 + 8 维 rating 余弦 | **受控标签精确匹配** | 标签无同义词问题，BM25 命中率远高于自由文本 |
| 是否需要 embedding | 讨论中 | **不需要** | 受控标签是精确匹配，embedding 模型变成多余的复杂度 |
| `atmosphere_signature` | 参与匹配计算 | **回归本职**（仅 assess_lighting 输出） | rating 向量是"当前 vs 参考"的差距，不应作为预设指纹 |
| `description` | 必须由 LLM 手写 | **Vision API 自动生成** | 消除人为词汇漂移，同一张图两次分析产出相似标签 |
| 词汇表 | 编译时常量 `as const` | **编译时基础 + 运行时扩展** | 用户可永久新增标签，Prompt 自动更新 |

---

## 2. 标签体系

### 2.1 设计原则

- **受控标签**：5 个维度，每维度有编译时基础值 + 运行时扩展值 + `unspecified`。`===` 精确匹配。
- **自由标签**：开放字符串列表。Jaccard 加分，不匹配不扣分。
- **`unspecified`**：当某维度无法归类时使用。匹配时该维度跳过（不计入分子也不计入分母）。
- **词汇表只增不减**：自定义标签一经用户确认即永久加入，无需删除机制（删除会导致已存预设的标签值语义混乱）。

### 2.2 标签定义

```typescript
// vision/analyzer.ts — 类型定义、运行时常量、校验逻辑位于同一文件，单一事实来源

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

// ═══════════════════════════════════════════
// 运行时扩展词汇表
// ═══════════════════════════════════════════

/** 从 ~/.pi/agent/tag-vocabulary.json 加载的自定义标签 */
let _customVocabulary: Record<string, string[]> = {};

/** 初始化：从文件加载自定义词汇 */
export function loadCustomVocabulary(): void { /* 读取 tag-vocabulary.json → _customVocabulary */ }

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

/** 运行时新增自定义标签（008f approve_tag 调用，内存立即生效 + 写入文件） */
export function addCustomTag(dim: ControlledTagDimension, value: string): void {
  if (!_customVocabulary[dim]) _customVocabulary[dim] = [];
  if (!_customVocabulary[dim].includes(value)) {
    _customVocabulary[dim].push(value);
    writeVocabularyFile();  // 持久化到 tag-vocabulary.json
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

/**
 * Vision API 分析单张图片的结构化输出。
 * analyzeAndTag() 返回此类型。
 */
export interface TagResult {
  /** 1-3 句自然语言摘要，给 LLM 阅读 */
  description: string;
  /** 受控标签，用于代码层精确匹配 */
  tags: PresetTags;
  /** 自由标签（0-5 个），加分项 */
  freeformTags: string[];
  /** 运行时校验结果 */
  validation: TagValidation;
}

/** 运行时标签校验结果 */
export interface TagValidation {
  /** 整体是否完全合法（所有维度值都在有效词汇表中） */
  isValid: boolean;
  /** 非法标签明细 */
  unknownTags: Array<{ dimension: ControlledTagDimension; value: string }>;
}
```

### 2.3 Prompt 设计（动态生成）

`vision/prompts.ts` 中提供 `buildTaggingPrompt()` 函数，每次生成 prompt 时动态读取最新的有效词汇表。

```
你是一个游戏光照分析助手。

分析这张图片的光照氛围，返回结构化标签。

对以下 5 个维度，每个维度从列出的选项中选择最匹配的一个值。
如果所有选项都不符合图片特征，选择 "unspecified"。
你必须从列出的选项中选择——不要创造新值。

维度:
  1. time_of_day [golden_hour, midday, dusk, night, dawn, overcast, unspecified]:
     - golden_hour  — 温暖的倾斜低角度日光，长阴影，橙/金色调
     - midday       — 明亮的顶光，短阴影，中性白光
     - dusk         — 黄昏，太阳低于地平线但天空仍有色彩，紫/粉色调
     - night        — 夜晚场景，月光或人造光源照明
     - dawn         — 清晨，冷调淡色，太阳接近地平线
     - overcast     — 阴天漫射光，无明确太阳方向，灰调天空感
     - unspecified  — 以上皆不符合

  2. color_palette [warm, cool, neutral, warm_cool_contrast, unspecified]:
     - warm                — 全局暖调（橙/金色）
     - cool                — 全局冷调（蓝/白）
     - neutral             — 自然中性色调
     - warm_cool_contrast  — 画面不同区域有明显色温差异（暖高光 + 冷阴影）
     - unspecified         — 以上皆不符合

  3. atmosphere [clear, light_fog, heavy_fog, mist, haze, storm, unspecified]:
     - clear      — 完全清晰，无任何大气效果
     - light_fog  — 轻微雾气，远处稍有衰减
     - heavy_fog  — 浓雾，近处也可见明显雾效
     - mist       — 薄雾，地面附近有轻纱感
     - haze       — 霾，远距离衰减但无体积感
     - storm      — 暴风雨/沙尘暴，极端天气效果
     - unspecified — 以上皆不符合

  4. light_direction [front, side, back, top, ambient, low_angle, unspecified]:
     - front      — 主光从相机方向来（顺光）
     - side       — 主光从侧面来（侧光）
     - back       — 主光从被摄体后方来（逆光）
     - top        — 主光从正上方来（顶光）
     - ambient    — 无明显方向，全方向漫射
     - low_angle  — 主光以低角度射入（斜射）
     - unspecified — 以上皆不符合

  5. mood [bright, dark, moody, vibrant, muted, dramatic, unspecified]:
     - bright      — 明亮愉快
     - dark        — 黑暗沉重
     - moody       — 氛围感强，情绪化
     - vibrant     — 鲜艳活泼
     - muted       — 柔和低沉
     - dramatic    — 戏剧化，强对比
     - unspecified — 以上皆不符合

此外:
  - description: 1-3 句自然语言描述该图的光照氛围
  - freeformTags: 0-5 个上述维度未覆盖的场景特征词
    (如 "ocean_horizon", "mountain_silhouette", "indoor", "god_rays")

返回纯 JSON（无 markdown 代码块）:

{
  "description": "Warm golden hour sunlight over ocean horizon...",
  "tags": { "time_of_day": "golden_hour", "color_palette": "warm", ... },
  "freeformTags": ["ocean_horizon", "god_rays"]
}
```

**注意**：`buildTaggingPrompt()` 的动态部分——每个维度的 `[golden_hour, midday, ...]` 选项列表来自 `getEffectiveVocabulary(dim)`，自动合并 BASE + tag-vocabulary.json 中的自定义值。基础值带中文描述，自定义值仅列出英文名（无描述，但 Vision 模型对英文标签有充足语义理解）。

**验收标准**：同一张图片连续分析 3 次，受控标签完全一致的频率 ≥ 2/3。

### 2.4 运行时标签校验（Phase 1：静默降级 + 别名映射）

`analyzeAndTag()` 在 Vision 返回 JSON 后、解析为 `TagResult` 前，执行校验：

```typescript
// vision/analyzer.ts

function validateTags(raw: Record<string, unknown>): TagResult {
  const tags: PresetTags = { time_of_day: "", color_palette: "", atmosphere: "", light_direction: "", mood: "" };
  const unknownTags: TagValidation["unknownTags"] = [];

  for (const dim of Object.keys(BASE_TAG_VALUES) as ControlledTagDimension[]) {
    const rawValue = String(raw[dim] ?? "unspecified");

    // Step 1: 尝试别名映射（~/.pi/agent/tag-aliases.json，用户可手动编辑）
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

    // Step 3: 未知值 → 降级为 unspecified + 记录
    tags[dim] = "unspecified";
    unknownTags.push({ dimension: dim, value: rawValue });
  }

  return {
    description: String(raw.description ?? ""),
    tags,
    freeformTags: Array.isArray(raw.freeformTags) ? raw.freeformTags : [],
    validation: {
      isValid: unknownTags.length === 0,
      unknownTags,
    },
  };
}
```

**Phase 1 降级策略**（008a 实施）：未知标签降级为 `unspecified`，记录到 `validation.unknownTags`（用于调试日志），不打断流程。

**Phase 2 TAG_REVIEW 中断**（008f 远期实施）：当 `validation.unknownTags.length > 0` 时，触发 TAG_REVIEW phase（详见 §14）。

---

## 3. 流程设计

### 3.1 保存流程

```
用户确认满意 → LLM 调 save_preset(name)
       │
       ├── captureViewport()                     ← 复用 vision/capture.ts
       │       → { filePath, base64 }
       │
       ├── analyzeAndTag(vision, screenshotBase64) ← 复用 vision/analyzer.ts
       │       → { description, tags, freeformTags, validation }
       │
       ├── capturePresetState(ueClient)           ← presets/capture.ts
       │       → { DirectionalLight_0: {...}, SkyLight_0: {...}, ... }
       │
       └── savePresetEntry(presetsDir, entry)     ← presets/store.ts
               → ~/.pi/agent/presets/<name>/
               │   ├── preset.json
               │   └── <name>.png                       ← 截图副本

参数: name（必填）——用户指定预设名称
description 和 reference_path 不再需要——均由代码自动生成
```

### 3.2 匹配流程

```
用户提供参考图 → assess_lighting 并行执行:
       │
       ├── ATMOSPHERE_ANALYSIS_PROMPT  → 8 维 rating（已有，不改）
       └── analyzeAndTag(refBase64)    → TagResult（新增）
              │
              ▼
       matchPresetsByTags(tagResult, presets)      ← presets/match.ts
              │
              ├── 受控标签：精确匹配计数 / 可比维度数
              ├── 自由标签：Jaccard 加分
              └── score >= 0.5 → 候选
              │
              ▼
       before_agent_start 注入 top-3（assessCount <= 2 时）
```

### 3.3 加载流程

```
LLM 决定加载 → load_preset("golden-hour-ocean")
       │
       ├── loadPresetEntry(dir, name)             ← presets/store.ts
       ├── applyPreset(ueClient, entry)           ← presets/apply.ts
       │       ├── set_actor_transform(DirectionalLight rotation)
       │       └── set_properties(各组件属性)
       ├── 更新 _activeReferencePath 指向预设截图
       └── 返回摘要
```

---

## 4. 预设数据模型

```typescript
// presets/types.ts
import type { PresetTags } from "../vision/analyzer.ts";

interface PresetActor {
  refPath: string;
  transform?: { rotation: { Pitch: number; Yaw: number; Roll: number } };
  components: Record<string, Record<string, unknown>>;
}

interface PresetEntry {
  name: string;
  description: string;          // Vision 自动生成的自然语言描述
  tags: PresetTags;             // 受控标签（5 维度，用于 BM25 匹配）
  freeformTags: string[];       // 自由标签（加分项）
  screenshot: string;           // 截图文件名（相对预设目录）
  actors: Record<string, PresetActor>;  // 5 类氛围组件属性快照
  postprocessReset: boolean;    // 加载时是否回退 PostProcessVolume
  created: string;              // ISO 8601
}

interface PresetMatch {
  name: string;
  description: string;
  score: number;                // 0-1 综合分
  matchedDimensions: string[];  // 具体哪些受控标签匹配
}
```

### 4.1 快照范围（与 v1 一致）

| 组件类型 | 快照内容 |
|------|------|
| DirectionalLight | LightColor, Intensity, Temperature, LightSourceAngle + transform(rotation) |
| SkyLight | LightColor, Intensity |
| SkyAtmosphere | MieScatteringScale, MieScattering, MieExponentialDistribution, RayleighScatteringScale |
| ExponentialHeightFog | FogDensity, FogHeightFalloff, FogInscatteringLuminance, DirectionalInscatteringExponent |
| VolumetricCloud | LayerBottomAltitude, LayerHeight, bVisible |

PostProcessVolume 不存属性——只存 `postprocessReset: true` 标记。

---

## 5. 模块架构与可复用性分析

### 5.1 文件结构

```
packages/ue-harness/src/vision/
├── analyzer.ts         ← NEW: analyzeAndTag(), PresetTags, TagResult,
│                            BASE_TAG_VALUES, getEffectiveVocabulary(),
│                            isValidTagValue(), addCustomTag(), validateTags()
├── prompts.ts          ← EDIT: + buildTaggingPrompt()（动态生成）
├── vision-client.ts    ← 不改: VisionClient.sendAndParse<T>() 已有泛型
├── capture.ts          ← 不改: captureViewport() 已有
└── metrics.ts          ← 不改: computeMetrics() 已有

packages/ue-harness/src/presets/
├── types.ts            ← NEW: PresetEntry, PresetActor, PresetMatch
├── store.ts            ← NEW: loadAllPresets(), savePresetEntry(),
│                            loadPresetEntry(), deletePresetDir(),
│                            findPresetsByTagValue()
├── capture.ts          ← NEW: capturePresetState(ueClient) → Record<string, PresetActor>
├── apply.ts            ← NEW: applyPreset(ueClient, entry) → ApplyResult
├── match.ts            ← NEW: matchPresetsByTags(queryTags, queryFreeform, presets) → PresetMatch[]
└── tools.ts            ← NEW: createSaveTool/createListTool/createLoadTool/createDeleteTool

packages/ue-harness/src/
├── index.ts            ← EDIT: 注册 4 个预设工具 + before_agent_start 注入匹配建议
├── state.ts            ← EDIT: + _activeReferencePath getter/setter
└── workflow/
    └── injections.ts   ← EDIT: + buildPresetSuggestion()
```

### 5.2 可复用元素清单（防止重复定义）

| 元素 | 定义于 | 使用者 | 复用场景 |
|------|--------|--------|---------|
| `VisionClient.sendAndParse<T>()` | `vision/vision-client.ts` | `analyzeAndTag()`, `assess_lighting`, `check_dimension` | 已有泛型，无需改动 |
| `captureViewport()` | `vision/capture.ts` | `assess_lighting`, `save_preset` | 已有，零改动 |
| **`analyzeAndTag()`** | `vision/analyzer.ts` | `assess_lighting` 流程（参考图分析）, `save_preset` 流程（截图分析） | **核心复用——同一函数，两种调用场景** |
| **`PresetTags`** | `vision/analyzer.ts` | `presets/types.ts`（类型引用）, `presets/match.ts`（匹配算法）, `presets/capture.ts`（写入预设） | 单一类型定义，全模块引用 |
| **`TagResult`** | `vision/analyzer.ts` | `assess_lighting`（存储 matching 所需标签）, `save_preset`（获取标签写入 preset.json） | 同步计算结果，无需重新计算 |
| **`BASE_TAG_VALUES`** | `vision/analyzer.ts` | Prompt 生成, 运行时校验, 匹配算法 | 编译时基础词汇，类型约束 |
| **`getEffectiveVocabulary()`** | `vision/analyzer.ts` | `buildTaggingPrompt()`, `isValidTagValue()`, `validateTags()` | 基础 + 扩展合并，所有需要词汇列表的地方统一调用 |
| **`isValidTagValue()`** | `vision/analyzer.ts` | `validateTags()`, guard rules (008f) | 运行时类型安全 |
| `buildTaggingPrompt()` | `vision/prompts.ts` | `vision/analyzer.ts` 的 `analyzeAndTag()` | 每次调用时动态生成，自动纳入最新词汇表 |
| `PresetEntry` | `presets/types.ts` | store, capture, apply, match, tools | 全预设模块引用 |
| `PresetMatch` | `presets/types.ts` | match, injections | 匹配结果类型 |
| `getUeClient()` | `state.ts` | capture, apply | 已有模式 |
| `getVisionClient()` | `state.ts` | analyzer（通过工具 execute 间接调用） | 已有模式 |
| `_activeReferencePath` | `state.ts` | assess_lighting, check_dimension, load_preset | **新增状态——确保只在一处维护** |

### 5.3 依赖方向

```
vision/analyzer.ts         ← 不依赖任何预设模块
       ↑
presets/types.ts           ← 导入 PresetTags（单向依赖：presets → vision）
presets/match.ts           ← 导入 PresetTags, analyzeAndTag
presets/capture.ts         ← 导入 PresetTags, analyzeAndTag, captureViewport
presets/store.ts           ← 导入 PresetEntry（仅 types）
presets/apply.ts           ← 导入 PresetEntry（仅 types）
presets/tools.ts           ← 导入 store, capture, apply, match
```

`vision/` 对 `presets/` 零依赖。

---

## 6. 匹配算法

### 6.1 `matchPresetsByTags()` — 纯函数，无 I/O

```typescript
// presets/match.ts
export function matchPresetsByTags(
  queryTags: PresetTags,
  queryFreeform: string[],
  presets: PresetEntry[],
): PresetMatch[] {
  const DIMS: ControlledTagDimension[] = [
    "time_of_day", "color_palette", "atmosphere", "light_direction", "mood"
  ];

  const results: PresetMatch[] = [];

  for (const preset of presets) {
    // 受控标签：仅比较双方都非 unspecified 的维度
    let hits = 0, comparable = 0;
    const matchedDims: string[] = [];

    for (const dim of DIMS) {
      const q = queryTags[dim], p = preset.tags[dim];
      if (q === "unspecified" || p === "unspecified") continue;
      comparable++;
      if (q === p) { hits++; matchedDims.push(dim); }
    }

    // 至少 2 个可比维度才计分
    if (comparable < 2) continue;

    const controlledScore = hits / comparable;

    // 自由标签：Jaccard 加分
    const intersection = queryFreeform.filter(t =>
      preset.freeformTags.includes(t)
    ).length;
    const union = new Set([...queryFreeform, ...preset.freeformTags]).size;
    const freeformScore = union > 0 ? intersection / union : 0;

    const score = controlledScore * 0.85 + freeformScore * 0.15;

    if (score >= 0.5 && hits >= 2) {
      results.push({
        name: preset.name,
        description: preset.description,
        score: Math.round(score * 100) / 100,
        matchedDimensions: matchedDims,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}
```

### 6.2 词汇表扩展对已有预设的影响

`matchPresetsByTags()` 只做 `===` 比较，不关心值来自基础词汇表还是自定义词汇表。但词汇表扩展后：

- 新参考图的标签可能更精确（如 `time_of_day: "sunset"`）
- 旧预设保存时用的是旧词汇（如 `time_of_day: "golden_hour"`）
- `"sunset" !== "golden_hour"` → 该维度不匹配

**缓解**：
1. **自动容错** — 5 维中丢 1 维，4/5 仍 ≥ 0.5 阈值，预设不至于匹配不到
2. **`findPresetsByTagValue(dim, oldValue)`** — `store.ts` 提供查询哪些预设使用了被"分裂"的旧标签值
3. **`reanalyze_preset` 工具**（008f）— 读预设截图 → analyzeAndTag → 原地更新标签，不动 actors

### 6.3 为什么不需要 embedding？

标签是**精确匹配**，不存在同义词问题。`golden_hour` 永远等于 `golden_hour`。自由标签用 Jaccard 做模糊匹配，但权重仅 0.15。BM25 在此场景下等价于精确匹配计数（IDF 对标签无意义，所有 vocabulary 在每个文档中最多出现一次）。

---

## 7. 工具 API 设计

| 工具 | 参数 | 行为 |
|------|------|------|
| `save_preset` | `name: string` | 截图→analyzeAndTag→快照场景→写磁盘。description/tags/screenshot 均由代码自动生成 |
| `list_presets` | — | 列出所有预设（name, description, tags, created, screenshot） |
| `load_preset` | `name: string` | 读 JSON → 批量 apply → 更新 `_activeReferencePath`。LLM 主动调用 |
| `delete_preset` | `name: string` | 删除整个子目录 |

### 7.1 `save_preset` 同名覆盖

不加 `overwrite` 参数。首次调用时如果同名预设存在，**直接返回错误**并提示 LLM 向用户请求覆盖许可：

```json
{
  "success": false,
  "error": "预设 'golden-hour-ocean' 已存在（创建于 2026-08-10T15:00:00Z）。如需覆盖，请先向用户确认，然后调 delete_preset('golden-hour-ocean') 后再调 save_preset。"
}
```

流程：
```
LLM 调 save_preset("golden-hour-ocean")
  → 同名存在 → 返回错误
  → LLM 告知用户："预设 golden-hour-ocean 已存在，是否覆盖？"
  → 用户确认后: delete_preset + save_preset
```

此设计不需要修改工具签名，不需要额外的 `confirm_overwrite` 参数。

### 7.2 `load_preset` 是工具，不自动触发

即使标签 5/5 匹配，也不自动应用预设。原因：
- 用户可能已手动调整非氛围属性（材质、几何），自动覆盖 = 数据丢失
- "参考图是金色夕阳" ≠ "我要用金色夕阳预设"。用户可能想从零调
- LLM 解释用户意图，代码只负责信息检索

自动化边界：
- **代码自动**：analyzeAndTag → matchPresetsByTags → before_agent_start 注入建议
- **LLM 决定**：看建议 → load_preset 或忽略

---

## 8. `before_agent_start` 注入

### 8.1 注入条件

```
条件:
  1. assess_lighting 完成 (state.phase >= TUNING)
  2. state.lastTagResult 存在（assess_lighting 中已并行调用 analyzeAndTag）
  3. matchPresetsByTags 找到 score >= 0.5 的预设
  4. state.assessCount <= 2（前两次全局评估时注入，后续 LLM 已知预设列表，不再重复）

注入文本:
  ## 匹配的预设

  以下预设与当前参考图的氛围特征相似，可提供更好的调参起点:
    [1] golden-hour-ocean (标签匹配: 4/5, 得分 0.92)
        Warm golden hour sunlight over ocean horizon, heavy fog...
        匹配维度: time_of_day=golden_hour, color_palette=warm,
                 atmosphere=heavy_fog, light_direction=low_angle
    [2] purple-dusk-mountain (标签匹配: 3/5, 得分 0.71)
        Purple-pink dusk with soft fog over mountain silhouette...
        匹配维度: time_of_day=dusk, color_palette=warm, atmosphere=mist

  如果你认为某个预设比当前默认场景更适合作为起点:
    调 load_preset('name') 批量应用该预设 → 调 assess_lighting() 检验效果

  不使用预设则忽略此建议，继续手动调参。

  (unspecified = 该维度在此预设或参考图中无法归类，已自动忽略不计分)
```

### 8.2 `unspecified` 的语义传递

在注入文本末尾追加一行说明 `unspecified` 的含义——LLM 看到匹配结果时自然理解被排除的维度。不需要在 prompt 中额外解释。

### 8.3 注入实现

在 `injections.ts` 中新增 `buildPresetSuggestion(matches: PresetMatch[]): string`，由 `before_agent_start` handler 调用。

---

## 9. `_activeReferencePath` 状态

`state.ts` 新增 getter/setter：

```typescript
let _activeReferencePath: string | null = null;

export function setActiveReferencePath(path: string | null): void {
  _activeReferencePath = path;
}

export function getActiveReferencePath(): string | null {
  return _activeReferencePath;
}
```

生命周期：
```
load_preset("golden-hour-ocean")
  → setActiveReferencePath("~/.pi/agent/presets/golden-hour-ocean/golden-hour-ocean.png")

LLM 调 assess_lighting() 不传 reference_path
  → 自动使用 getActiveReferencePath()

LLM 调 assess_lighting("other.png") 显式传参
  → 覆盖 _activeReferencePath，设为 "other.png"
```

---

## 10. 边界条件

| 场景 | 处理 |
|------|------|
| save_preset 时场景中无氛围组件 | 部分捕获，返回 `missing_actors` 列表，不阻断 |
| save_preset 时 Vision API 不可用 | 返回错误，预设不保存 |
| save_preset 时同名预设存在 | 返回错误 `{ success: false, error: "预设已存在..." }`，提示 LLM delete_preset 后再保存 |
| save_preset 时 Vision 返回未知标签 | Phase 1：降级为 unspecified + 日志记录。Phase 2 (008f)：触发 TAG_REVIEW |
| 预设文件 JSON 损坏 | store 加载时跳过，list_presets 标记为 corrupted |
| load_preset 时 actor 缺失 | 跳过该 actor，在返回中报告 |
| load_preset 时属性部分失败 | 捕获错误继续，汇总失败项 |
| load_preset 后参考图已丢失 | 不影响——预设自包含截图 |
| 匹配时所有维度都是 unspecified | score=0，不匹配任何预设 |
| 匹配时无预设（首次使用） | 返回空数组，不注入建议 |
| 多个预设匹配分接近（差 < 0.05） | 全部列出，由 LLM 选择 |
| 词汇表扩展后旧预设标签陈旧 | 匹配容错（丢 1 维仍可过阈值）+ `findPresetsByTagValue()` 查询 + 008f `reanalyze_preset` |
| 大预设（>20 组件） | 不做分批——UeClient 串行处理 |
| 不跨 UE 项目 | actor refPath 绑定项目名 |

---

## 11. 不改动范围

1. **不自动应用预设** — LLM 始终需要主动调 `load_preset`
2. **不跨 UE 项目共享** — actor refPath 含项目名
3. **不保存非氛围属性** — 只快照 5 类氛围组件
4. **不使用 embedding 模型** — 受控标签精确匹配已足够
5. **不保留参考图** — 预设以截图为 ground truth

---

## 12. 文件级数据存储

### 12.1 预设存储结构

```
~/.pi/agent/presets/
├── golden-hour-ocean/
│   ├── preset.json              ← PresetEntry
│   └── golden-hour-ocean.png   ← 保存时的当前视口截图
├── purple-dusk-mountain/
│   ├── preset.json
│   └── purple-dusk-mountain.png
└── foggy-morning-forest/
    ├── preset.json
    └── foggy-morning-forest.png
```

参考图不再存储——预设以截图自包含。截图文件名为 `{preset_name}.png`。

### 12.2 词汇表文件

```
~/.pi/agent/
├── tag-vocabulary.json     ← 用户确认的自定义标签（只增不减）
└── tag-aliases.json        ← 别名映射文件（静默降级用，用户可手动编辑）
```

`tag-vocabulary.json` 格式：
```json
{
  "time_of_day": ["sunset"],
  "atmosphere": [],
  "color_palette": [],
  "light_direction": [],
  "mood": []
}
```

`tag-aliases.json` 格式：
```json
{
  "time_of_day": { "sunset": "golden_hour", "nighttime": "night" },
  "atmosphere": { "foggy": "light_fog", "dense_fog": "heavy_fog" }
}
```

---

## 13. 实施 Issue 拆分（008a-008e，立即执行）

| Issue | 内容 | 新增/编辑文件 | 预计 |
|:--:|------|------|:--:|
| 008a | 基础：标签分析器 + 类型 + 存储 | `vision/analyzer.ts`(N), `vision/prompts.ts`(E: +`buildTaggingPrompt()`), `presets/types.ts`(N), `presets/store.ts`(N) | 1.5 天 |
| 008b | 保存路径：场景快照 + save/list/delete 工具 | `presets/capture.ts`(N), `presets/tools.ts`(N: save/list/delete), `index.ts`(E) | 1.5 天 |
| 008c | 匹配路径：标签匹配 + before_agent_start 注入 | `presets/match.ts`(N), `state.ts`(E: +`_activeReferencePath`), `workflow/injections.ts`(E: +`buildPresetSuggestion()`), `index.ts`(E) | 1 天 |
| 008d | 加载路径：属性应用 + load_preset 工具 | `presets/apply.ts`(N), `presets/tools.ts`(E: +load), `index.ts`(E) | 1.5 天 |
| 008e | 测试 + 边界条件 | 各文件边界处理 + 测试 | 1 天 |

**总计**: ~5-6 天

### 13.1 依赖关系

```
008a (types + analyzer + store)
  ├── 008b (capture + save/list/delete)  ← 依赖 008a 的 store + types
  ├── 008c (match + injection)           ← 依赖 008a 的 analyzer + types
  └── 008d (apply + load)                ← 依赖 008a 的 store + types
       └── 008e (test + edges)            ← 依赖全部
```

008b 和 008c 可并行开发（共享 008a，互不依赖）。008d 必须等 008a 完成，但可与 008b/008c 并行。

### 13.2 每 Issue 的可复用产出

| Issue | 产出 | 被谁复用 |
|:--:|------|------|
| 008a | `analyzeAndTag()` | 008b（save_preset 截图分析）, 008c（参考图分析）, 008f（reanalyze_preset） |
| 008a | `PresetTags` 类型 | 008b（types）, 008c（match）, 008d（不直接使用） |
| 008a | `BASE_TAG_VALUES` | 008a（prompt 生成）, 008a（校验）, 008c（match 算法遍历维度） |
| 008a | `getEffectiveVocabulary()` | 008a（prompt 生成）, 008a（校验）, 008f（approve_tag 后 prompt 自动更新） |
| 008a | `isValidTagValue()` | 008a（校验）, 008f（guard rules 判断是否需要 TAG_REVIEW） |
| 008a | `validateTags()` | 008a（analyzeAndTag 内部）, 008f（reanalyze_preset） |
| 008a | `loadAllPresets()` | 008c（match 加载候选）, 008b（list_presets） |
| 008b | `capturePresetState()` | 仅 008b（保存时快照） |
| 008c | `matchPresetsByTags()` | 仅 008c（匹配逻辑） |
| 008d | `applyPreset()` | 仅 008d（加载时应用） |

---

## 14. 远期 Issue 008f — TAG_REVIEW 中断 + 运行时词汇表扩展

**状态**: 已规划，不立即实施
**依赖**: 008a-008e 全部完成
**预计**: 2 天

### 14.1 动机

Phase 1（008a）中，Vision 返回的未知标签被静默降级为 `unspecified`。当基础词汇表确实无法覆盖某些场景类型时，用户需要一个**运行时扩展词汇表**的入口——且该入口必须中断 LLM 的正常调参流程，防止 LLM 在标签未正确处理的情况下继续操作。

### 14.2 触发链路

```
Turn N: LLM 调 assess_lighting → analyzeAndTag 返回 validation.unknownTags 非空
  → tool_result 事件中 phase → TAG_REVIEW（同步，在 LLM 看到结果前完成）

Turn N+1: before_agent_start 强注入 TAG_REVIEW 上下文
  → guard rules 阻止所有调参工具（set_properties, check_dimension, assess_lighting）
  → 仅允许: approve_tag, reject_tag, list_presets, load_preset, delete_preset

LLM 调 approve_tag 或 reject_tag
  → phase → TUNING（guard 解除）
```

### 14.3 新增 Phase

```typescript
type Phase = "SETUP" | "TUNING" | "POSTPROCESS_SETUP" | "TAG_REVIEW" | "FINAL" | "DONE";
```

`TAG_REVIEW` 是临时中断态，唯一出口是 `approve_tag` 或 `reject_tag`。

### 14.4 PhaseState 扩展

```typescript
interface PhaseState {
  // ... 已有字段
  pendingUnknownTags: Array<{ dimension: ControlledTagDimension; value: string }>;
}
```

### 14.5 新增工具

| 工具 | 参数 | 行为 |
|------|------|------|
| `approve_tag` | `dimension: string, value: string` | `addCustomTag(dim, value)` → 写入 `tag-vocabulary.json` → phase → TUNING。返回 `affected_presets` 列表（标签较旧的预设） |
| `reject_tag` | `dimension: string, value: string` | 不写入文件 → phase → TUNING。下次 Vision 可能再次返回同一值，再次触发 TAG_REVIEW |
| `reanalyze_preset` | `name: string` | 读预设截图 → `analyzeAndTag(screenshot)` → 原地更新 `preset.json` 的 tags/freeformTags/description。不动 actors |

**注意**：`approve_tag` 和 `reject_tag` 都能解除 TAG_REVIEW guard。LLM 必须向用户确认后才能调用——工具描述中写明"此操作需用户确认"。

### 14.6 guard 规则

```
TAG_REVIEW 阶段:
  ✅ 允许: approve_tag, reject_tag, list_presets, load_preset, delete_preset
  ❌ 阻止: 所有 UE 调参工具 + assess_lighting + check_dimension + captureViewport
  阻止原因: "TAG_REVIEW: 必须先处理未知标签（approve_tag 或 reject_tag）"
```

### 14.7 before_agent_start 注入

```
## ⚠️ TAG_REVIEW: 发现未知标签

Vision 分析返回了不在当前词汇表中的标签值:
  time_of_day: "sunset" （当前可选: golden_hour, midday, dusk, night, dawn, overcast, unspecified）

**请询问用户如何处理:**

A) 用户认为 "sunset" 是合理的新标签，应加入词汇表
     → 调 approve_tag('time_of_day', 'sunset') 永久加入

B) 用户认为应回退为 unspecified
     → 调 reject_tag('time_of_day', 'sunset') 跳过

在用户做出决定前，所有调参工具已被阻止。你必须先向用户确认，不得自行决定。
```

### 14.8 approve_tag 返回

```json
{
  "approved": true,
  "dimension": "time_of_day",
  "value": "sunset",
  "affected_presets": [
    {
      "name": "golden-hour-ocean",
      "current_tag": "golden_hour",
      "hint": "此预设的 time_of_day 标签为旧值 'golden_hour'，建议用户调 reanalyze_preset('golden-hour-ocean') 更新标签"
    }
  ]
}
```

`affected_presets` 由 `findPresetsByTagValue(dim, "golden_hour")` 定位——找出所有在同一维度使用了"被新标签分裂"的旧标签值的预设。

### 14.9 类型安全策略

`PresetTags` 的字段类型保持 `string`（非字面量联合），类型安全由运行时 `isValidTagValue()` 和 `validateTags()` 保证。`BASE_TAG_VALUES` 的 `as const` 保留用于 IDE 补全和基础值的中文描述映射。

这使 `approve_tag` 能随时扩展词汇表，而不需要 TypeScript 代码变更。

---

## 15. 文件级存储汇总

```
~/.pi/agent/
├── presets/
│   ├── golden-hour-ocean/
│   │   ├── preset.json
│   │   └── golden-hour-ocean.png
│   └── ...
├── tag-aliases.json          ← 别名映射（手动编辑，静默降级）
├── tag-vocabulary.json       ← 用户确认的自定义标签（approve_tag 写入，只增不减）
└── vision-auth.json          ← 已有
```
