# Issue 010a — Tag 系统简化：去掉受控维度，只保留开放式标签

**状态**: Draft  
**依赖**: 无（与 010b、010c 并行独立）

---

## 动机

当前 tag 系统有 5 个硬编码的受控维度（`time_of_day`, `color_palette`, `atmosphere`, `light_direction`, `mood`），每个维度有封闭的词汇表。Vision 模型几乎从不返回词汇表内的值，导致 99% 的受控标签降级为 `"unspecified"`。

`assess_lighting` 的 Vision prompt 完全不使用这套维度分类——它输出的是自由命名的 `aspect`（如 "brightness", "shadow_warmth"）。标签系统是独立通道，唯一被消费的地方是预设匹配。

**目标**：
- 受控维度全部删除，只保留开放式标签（`freeformTags` → 改名为 `tags`）
- 预设匹配从"受控维度精确匹配 + 自由标签 Jaccard 加分"改为"纯 Jaccard overlap → top-10"
- 提取 `TagScorer` 接口，为未来 embedding 替换预留空间

---

## 一、analyzer.ts — 删除受控标签基础设施

### 删除

```typescript
// 整块删除
export const BASE_TAG_VALUES = { ... };
export type ControlledTagDimension = keyof typeof BASE_TAG_VALUES;
export const CONTROLLED_DIMENSIONS: ControlledTagDimension[] = [...];
const VOCABULARY_PATH = ...;
const ALIASES_PATH = ...;
let _customVocabulary: Record<string, string[]> = {};
let _aliases: Record<string, Record<string, string>> = {};

export function loadCustomVocabulary(): void { ... }
export function writeVocabularyFile(): void { ... }
export function getEffectiveVocabulary(dim: ControlledTagDimension): string[] { ... }
export function isValidTagValue(dim: ControlledTagDimension, value: string): boolean { ... }
export function addCustomTag(dim: ControlledTagDimension, value: string): void { ... }
export function _resetForTest(): void { ... }
export function _setCustomVocabulary(vocab: Record<string, string[]>): void { ... }
export function _setAliases(aliases: Record<string, Record<string, string>>): void { ... }
```

### TagResult 类型变化

```typescript
// Before
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

// After
export interface TagResult {
  description: string;
  tags: string[];  // was freeformTags; max 5, open-ended
}
```

### validateTags 函数

```typescript
// Before (133-170): 5 维度逐个校验，词汇表匹配，降级，unknownTags 收集
export function validateTags(raw: Record<string, unknown>): TagResult { ... }

// After: 简单提取，不做词汇表校验
export function validateTags(raw: Record<string, unknown>): TagResult {
  return {
    description: String(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 5) : [],
  };
}
```

### analyzeAndTag — 签名不变，行为简化

函数签名保持 `(visionClient: VisionClient, imageBase64: string) => Promise<TagResult>` 不变。内部 prompt 改为简化版（见下文 prompts.ts），`validateTags` 改为简化版。

---

## 二、prompts.ts — 简化标签分析 prompt

### 删除

`buildTaggingPrompt()` 函数整体替换（约 60 行 → ~20 行）。

### Before（核心结构）

```
分析这张图片的光照氛围，返回结构化标签。
受控维度:
  time_of_day: [golden_hour, midday, dusk, night, dawn, overcast, unspecified]
  color_palette: [warm, cool, neutral, warm_cool_contrast, unspecified]
  ...
```

### After

```typescript
export function buildTaggingPrompt(): string {
  return `分析这张图片的光照氛围，返回结构化标签。

输出 JSON:
{
  "description": "1-2 句中文描述整体光照氛围",
  "tags": ["golden_hour", "ocean_horizon", "god_rays"]
}

tags: 0-5 个描述场景氛围特征的中文或英文词，用于后续预设匹配。`;
}
```

---

## 三、types.ts — PresetEntry 和 PresetMatch

```typescript
// Before
export interface PresetEntry {
  name: string;
  description: string;
  tags: PresetTags;
  freeformTags: string[];
  screenshot: string;
  actors: Record<string, PresetActor>;
  postprocessReset: boolean;
  created: string;
}

export interface PresetMatch {
  name: string;
  description: string;
  score: number;
  matchedDimensions: string[];
}

// After
export interface PresetEntry {
  name: string;
  description: string;
  tags: string[];   // was PresetTags + freeformTags; now just a flat array
  screenshot: string;
  actors: Record<string, PresetActor>;
  postprocessReset: boolean;
  created: string;
}

export interface PresetMatch {
  name: string;
  description: string;
  score: number;         // 0–1, Jaccard
  matchedTags: string[]; // was matchedDimensions — overlapping tags
}
```

---

## 四、match.ts — 提取 TagScorer，改为纯 Jaccard

### 新增 TagScorer 接口

```typescript
/**
 * 标签打分函数。
 * 当前实现: Jaccard overlap。
 * 未来可替换为 embedding cosine similarity（签名不变，返回 number）。
 */
export type TagScorer = (queryTags: string[], presetTags: string[]) => number;
```

### jaccardTagScore 实现

```typescript
export function jaccardTagScore(queryTags: string[], presetTags: string[]): number {
  const intersection = queryTags.filter((t) => presetTags.includes(t)).length;
  const union = new Set([...queryTags, ...presetTags]).size;
  return union > 0 ? intersection / union : 0;
}
```

### matchPresetsByTags 重写

```typescript
// Before
export function matchPresetsByTags(
  queryTags: PresetTags,
  queryFreeform: string[],
  presets: PresetEntry[],
): PresetMatch[] {
  // 5 维度逐维比较，controlledScore * 0.85 + freeformScore * 0.15
  // cutoff: controlledScore >= 0.5 && hits >= 2
  // return top-3
}

// After
export function matchPresetsByTags(
  queryTags: string[],
  presets: PresetEntry[],
  options?: { scorer?: TagScorer; topN?: number },
): PresetMatch[] {
  const scorer = options?.scorer ?? jaccardTagScore;
  const topN = options?.topN ?? 10;

  const results: PresetMatch[] = [];
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

  return results
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, topN);
}
```

> **未来 embedding 扩展点**: 传入 `{ scorer: embeddingCosineScorer }` 即可切换，`matchPresetsByTags` 不需要任何内部改动。embedding scorer 内部需维护 embedding lookup（可能从 preset metadata 缓存），但 `(string[], string[]) => number` 签名不变。

---

## 五、tools.ts — save_preset / list_presets 适配新 TagResult

### executeSavePreset（97-106 行）

```typescript
// Before
const entry: PresetEntry = {
  name: params.name,
  description: tagResult.description,
  tags: tagResult.tags,
  freeformTags: tagResult.freeformTags,
  screenshot: `${params.name}.png`,
  ...
};

// After
const entry: PresetEntry = {
  name: params.name,
  description: tagResult.description,
  tags: tagResult.tags,  // string[] — was { tags, freeformTags }
  screenshot: `${params.name}.png`,
  ...
};
```

### save_preset 返回值（116-131 行）

```typescript
// Before
JSON.stringify({
  success: true, name: params.name,
  tags: tagResult.tags,           // PresetTags object
  freeformTags: tagResult.freeformTags,  // string[]
  actorCount, missingActors,
  validation: tagResult.validation,      // { isValid, unknownTags }
})

// After
JSON.stringify({
  success: true, name: params.name,
  tags: tagResult.tags,           // string[]
  actorCount, missingActors,
})
```

### list_presets 返回值（147-166 行）

```typescript
// Before
const summary = presets.map(p => ({
  name, description, tags: p.tags, freeformTags: p.freeformTags, created, screenshot
}));

// After
const summary = presets.map(p => ({
  name, description, tags: p.tags, created, screenshot
}));
```

---

## 六、index.ts — before_agent_start 匹配调用

[packages/ue-harness/src/index.ts:346-364](packages/ue-harness/src/index.ts#L346-L364)

```typescript
// Before
const matches = matchPresetsByTags(
  _phaseState.lastTagResult.tags,        // PresetTags
  _phaseState.lastTagResult.freeformTags, // string[]
  presets,
);

// After
const matches = matchPresetsByTags(
  _phaseState.lastTagResult.tags,  // string[] — already flat
  presets,
);
```

### index.ts:268 — 删除 loadCustomVocabulary 调用

```typescript
// Before
loadCustomVocabulary();

// After
// (删除此行)
```

---

## 七、injections.ts — buildPresetSuggestion 适配

```typescript
// Before
text += `  [${i + 1}] ${m.name} (标签匹配: ${m.matchedDimensions.length}/5, 得分 ${m.score})\n`;
text += `      ${m.description}\n`;
text += `      匹配维度: ${m.matchedDimensions.join(", ")}\n`;
// ...
text += `(unspecified = 该维度在此预设或参考图中无法归类，已自动忽略不计分)\n`;

// After
text += `  [${i + 1}] ${m.name} (匹配标签: ${m.matchedTags.join(", ")}, 得分 ${m.score})\n`;
text += `      ${m.description}\n`;
// 删除 unspecified 提示行
```

---

## 八、assess-lighting.ts — tagResult 类型自动适应

`AssessLightingResult.tagResult?: TagResult` 不需要改动。`TagResult` 类型变了后自动跟随新形状。

---

## 九、存量测试适配

| 文件 | 改动 |
|------|------|
| `test/presets-008a-analyzer.mjs` | 重写：不再测试词汇表/维度校验，改为测试 TagResult 提取 + 截断 |
| `test/presets-008b-tools.mjs` | 更新 `tags` 字段期望值 |
| `test/presets-008a-store.mjs` | 更新 preset JSON fixtures（去掉 freeformTags，tags 改为 string[]） |
| `test/presets-008e-match.mjs` | 重写：Jaccard 匹配、top-10、score > 0 过滤 |

---

## 涉及文件清单（汇总）

| 文件 | 操作 |
|------|------|
| `src/vision/analyzer.ts` | 删除受控标签基础设施，简化 TagResult / validateTags |
| `src/vision/prompts.ts` | 替换 buildTaggingPrompt 为简化版 |
| `src/presets/types.ts` | PresetEntry.tags: string[], PresetMatch.matchedTags |
| `src/presets/match.ts` | 新增 TagScorer + jaccardTagScore，重写 matchPresetsByTags |
| `src/presets/tools.ts` | save_preset/list_presets 适配新 tag 格式 |
| `src/workflow/injections.ts` | buildPresetSuggestion 文案适配 |
| `src/index.ts` | 删除 loadCustomVocabulary，更新匹配调用 |
| `test/presets-008a-analyzer.mjs` | 重写 |
| `test/presets-008b-tools.mjs` | 适配 |
| `test/presets-008a-store.mjs` | 适配 |
| `test/presets-008e-match.mjs` | 重写 |
