# Issue 008c — 匹配路径：标签匹配 + before_agent_start 注入

**状态**: 待开工
**依赖**: Issue 008a 完成（`analyzeAndTag()`, `PresetTags`, `PresetEntry`, `PresetMatch`, `loadAllPresets()`, `CONTROLLED_DIMENSIONS`）
**预计**: 1 天
**PRD**: [docs/issue-008-preset-system.md](../../issue-008-preset-system.md)

---

## 1. 目标

实现预设的**匹配路径**：新参考图 → `analyzeAndTag()` → `matchPresetsByTags()` → top-3 匹配结果 → `before_agent_start` 注入建议。

同时引入 `_activeReferencePath` 状态（`state.ts`），供 008d `load_preset` 消费。

---

## 2. 依赖

- 008a 产出：`analyzeAndTag()`, `PresetTags`, `PresetEntry`, `PresetMatch`, `CONTROLLED_DIMENSIONS`, `loadAllPresets()`
- 已有 `state.ts` 模式（getter/setter）
- 已有 `phase-machine.ts` 的 `PhaseState`（需要新增 `lastTagResult` 字段）
- 已有 `injections.ts` 的 `buildPhaseContext()` 等函数
- 已有 `index.ts` 的 `before_agent_start` handler 和 `assess_lighting` 的 `tool_result` handler

---

## 3. 产出文件

| 文件 | 操作 | 内容 |
|------|:--:|------|
| `packages/ue-harness/src/presets/match.ts` | N | `matchPresetsByTags()` — 纯函数 |
| `packages/ue-harness/src/state.ts` | E | 新增 `_activeReferencePath` getter/setter |
| `packages/ue-harness/src/workflow/injections.ts` | E | 新增 `buildPresetSuggestion()` |
| `packages/ue-harness/src/workflow/phase-machine.ts` | E | `PhaseState` 新增 `lastTagResult` 字段 |
| `packages/ue-harness/src/index.ts` | E | `assess_lighting` 流程中并行 `analyzeAndTag()` + `before_agent_start` 注入匹配建议 |

---

## 4. 详细规格

### 4.1 `presets/match.ts` — 匹配算法

```typescript
/**
 * Issue 008c — 预设标签匹配
 *
 * 纯函数：输入参考图标签 + 所有预设 → 输出排序后的 top-3 匹配。
 * 不调用 Vision API，不做 I/O。
 */

import { CONTROLLED_DIMENSIONS, type PresetTags } from "../vision/analyzer.ts";
import type { PresetEntry, PresetMatch } from "./types.ts";

/**
 * 基于受控标签 + 自由标签计算预设匹配分。
 *
 * 规则:
 *  - 受控标签: 双方都非 "unspecified" 的维度比较，精确 === 匹配
 *  - 至少 2 个可比维度才计分
 *  - 自由标签: Jaccard 加分（权重 0.15）
 *  - 受控分 >= 0.5 且 hits >= 2 → 候选
 *  - 返回 top-3
 */
export function matchPresetsByTags(
  queryTags: PresetTags,
  queryFreeform: string[],
  presets: PresetEntry[],
): PresetMatch[] {
  const results: PresetMatch[] = [];

  for (const preset of presets) {
    let hits = 0, comparable = 0;
    const matchedDims: string[] = [];

    for (const dim of CONTROLLED_DIMENSIONS) {
      const q = queryTags[dim], p = preset.tags[dim];
      if (q === "unspecified" || p === "unspecified") continue;
      comparable++;
      if (q === p) { hits++; matchedDims.push(dim); }
    }

    if (comparable < 2) continue;

    const controlledScore = hits / comparable;

    const intersection = queryFreeform.filter(t => preset.freeformTags.includes(t)).length;
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

### 4.2 `state.ts` 编辑

在文件末尾追加：

```typescript
// ═══════════════════════════════════════════
// Issue 008c — 活跃参考路径
// ═══════════════════════════════════════════

let _activeReferencePath: string | null = null;

export function setActiveReferencePath(path: string | null): void {
  _activeReferencePath = path;
}

export function getActiveReferencePath(): string | null {
  return _activeReferencePath;
}
```

### 4.3 `workflow/phase-machine.ts` 编辑

`PhaseState` 新增字段：

```typescript
// 在 PhaseState interface 中追加:
  /** Issue 008c: 上一次 analyzeAndTag 的结果，用于 before_agent_start 预设匹配 */
  lastTagResult?: import("../vision/analyzer.ts").TagResult;
```

`createInitialState()` 不需要显式设 `lastTagResult`（`undefined` 即为默认值）。

### 4.4 `workflow/injections.ts` 编辑

在文件末尾追加：

```typescript
// ═══════════════════════════════════════════
// Issue 008c — 预设匹配建议
// ═══════════════════════════════════════════

import type { PresetMatch } from "../presets/types.ts";

export function buildPresetSuggestion(matches: PresetMatch[]): string {
  if (!matches || matches.length === 0) return "";

  let text = "\n## 匹配的预设\n\n";
  text += "以下预设与当前参考图的氛围特征相似，可提供更好的调参起点:\n";

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    text += `  [${i + 1}] ${m.name} (标签匹配: ${m.matchedDimensions.length}/5, 得分 ${m.score})\n`;
    text += `      ${m.description}\n`;
    text += `      匹配维度: ${m.matchedDimensions.join(", ")}\n`;
  }

  text += `
如果你认为某个预设比当前默认场景更适合作为起点:
  调 load_preset('name') 批量应用该预设 → 调 assess_lighting() 检验效果

不使用预设则忽略此建议，继续手动调参。

(unspecified = 该维度在此预设或参考图中无法归类，已自动忽略不计分)
`;
  return text;
}
```

### 4.5 `index.ts` 编辑

**4.5.1 assess_lighting 流程中并行调用 analyzeAndTag**

`executeAssessLighting()` 的参数校验后（加载参考图 → base64 之后），在已有的 `Promise.all([...])` 中新增第四个调用：

```typescript
// 已有:
const [quantMetrics, refAtmosphere, curAtmosphere, artificiality] = await Promise.all([
  computeMetrics(...),
  analyzeAtmosphere(vision, refBase64),
  analyzeAtmosphere(vision, capture.base64),
  checkArtificiality(vision, capture.base64),
]);

// 新增 — 并行调用 analyzeAndTag:
import { analyzeAndTag, loadCustomVocabulary, type TagResult } from "../vision/analyzer.ts";

// 在 Promise.all 中和其他异步调用一起发出:
// 实际实施时，把 Promise.all 的数组从 4 个元素改为 5 个:
// const [quantMetrics, refAtmosphere, curAtmosphere, artificiality, refTagResult] = await Promise.all([...])
// 第 5 个: analyzeAndTag(vision, refBase64)
```

`TagResult` 需要回传进 `AssessLightingResult`，在返回的 JSON 中新增字段：

```typescript
// AssessLightingResult 新增字段:
tagResult?: TagResult;
```

**4.5.2 tool_result handler 中存储 TagResult**

```typescript
// 在 index.ts 的 tool_result handler ("assess_lighting" 分支) 中追加:
if (event.toolName === "assess_lighting") {
  try {
    const text = event.content?.[0]?.text || "";
    const data = JSON.parse(text);
    // ... 已有逻辑 ...

    // Issue 008c: 存储 TagResult 供 before_agent_start 使用
    if (data.tagResult) {
      _phaseState.lastTagResult = data.tagResult;
    }
  } catch {}
}
```

**4.5.3 before_agent_start handler 中注入匹配建议**

```typescript
// 在 before_agent_start handler 中追加（注入条件判断之后）:
import { loadAllPresets } from "./presets/store.ts";
import { matchPresetsByTags } from "./presets/match.ts";
import { buildPresetSuggestion } from "./workflow/injections.ts";

// 条件判断:
if (
  _phaseState.phase === "TUNING" &&
  _phaseState.lastTagResult &&
  _phaseState.assessCount <= 2
) {
  const presets = loadAllPresets();
  if (presets.length > 0) {
    const matches = matchPresetsByTags(
      _phaseState.lastTagResult.tags,
      _phaseState.lastTagResult.freeformTags,
      presets,
    );
    if (matches.length > 0) {
      appendix += buildPresetSuggestion(matches);
    }
  }
}
```

**4.5.4 session_start 中加载自定义词汇**

```typescript
// session_start handler 中，注册工具之前:
import { loadCustomVocabulary } from "./vision/analyzer.ts";
loadCustomVocabulary();
```

---

## 5. 边界条件

| 场景 | 处理 |
|------|------|
| 首次使用（无预设） | `loadAllPresets()` 返回 `[]`，`matchPresetsByTags` 返回 `[]`，不注入 |
| 参考图所有维度 unspecified | `matchPresetsByTags` 的 `comparable < 2` 跳过，不匹配任何预设 |
| Vision API 返回但 TagResult 解析失败 | `analyzeAndTag` 内部 `validateTags` 补 `unspecified`，匹配时 `comparable < 2` → 不匹配 |
| assess_lighting 第 3 次及以后 | `assessCount > 2` → 不注入（避免重复） |
| `lastTagResult` 为旧数据 | 新的 `assess_lighting` 会用新的 `TagResult` 覆盖——不会用旧标签匹配 |

---

## 6. 独立测试

### 6.1 `matchPresetsByTags()` — 纯函数，完全可测 ✅

测试文件：`packages/ue-harness/test/presets-match.test.ts`

```typescript
// 构造固定 PresetTags + 2 条预设，覆盖所有分支：

// Case 1: 完美匹配（5/5）
//   查询: [golden_hour, warm, heavy_fog, low_angle, dramatic], freeform: []
//   预设: [golden_hour, warm, heavy_fog, low_angle, dramatic], freeform: []
//   预期: score >= 0.95, matchedDimensions.length === 5

// Case 2: 部分匹配（3/5）
//   查询: [golden_hour, warm, clear, top, dramatic]
//   预设: [golden_hour, warm, heavy_fog, low_angle, dramatic]
//   comparable=5, hits=3 → controlledScore=0.6 → score >= 0.50

// Case 3: 双方各有 unspecified
//   查询: [golden_hour, unspecified, heavy_fog, low_angle, dramatic]
//   预设: [golden_hour, warm, unspecified, low_angle, bright]
//   comparable=3 (time_of_day, light_direction, mood)
//   hits=2 → controlledScore=0.67

// Case 4: comparable < 2 → 不匹配
//   查询: [golden_hour, unspecified, unspecified, unspecified, unspecified]
//   预设: [dusk, unspecified, unspecified, unspecified, unspecified]
//   comparable=1 → 跳过此预设

// Case 5: 全 unspecified → 不匹配
//   查询全 unspecified, 预设全 unspecified
//   comparable=0 → 跳过

// Case 6: 自由标签 Jaccard 加分
//   查询 freeform: ["ocean", "god_rays"]
//   预设 freeform: ["ocean", "silhouette"]
//   intersection=1, union=3 → freeformScore=0.33 → *0.15 = +0.05

// Case 7: 空自由标签
//   查询 freeform: [], 预设 freeform: ["ocean"]
//   intersection=0, union=1 → freeformScore=0

// Case 8: 自由标签完全匹配
//   查询 freeform: ["ocean"], 预设 freeform: ["ocean"]
//   intersection=1, union=1 → freeformScore=1.0 → +0.15

// Case 9: 多预设排序取 top-3
//   5 条预设，不同 score → 返回 3 条，按 score 降序

// Case 10: 分数相同时的确定性
//   2 条预设 score 完全相同 → 按 name 字母序固定顺序

// Case 11: score < 0.5 或 hits < 2 → 不包含在结果中
```

### 6.2 `buildPresetSuggestion()` — 纯函数，可测

```typescript
// Case 1: 2 条匹配 → 输出文本包含两条预设的名称、得分、匹配维度
//   buildPresetSuggestion([...2 matches...]) →
//     包含 "[1] preset-a (标签匹配: 4/5, 得分 0.92)"
//     包含 "匹配维度: time_of_day, color_palette..."
//     包含 "load_preset('name')" 的调用提示
//     包含 "unspecified = ..." 的说明

// Case 2: 空数组 → 返回 ""
//   buildPresetSuggestion([]) === ""

// Case 3: 1 条匹配 → 编号为 [1]，不出现 [2]
```

### 6.3 跳过项

| 函数/逻辑 | 原因 |
|------|------|
| `index.ts` 中 assess_lighting 并行调用 `analyzeAndTag` | 涉及 UE MCP + Vision API 的真实调用，008e 端到端验证 |
| `index.ts` 中 `before_agent_start` handler | 依赖 Pi 框架的事件循环，单元测试无法模拟 |
| `_activeReferencePath` getter/setter | 简单状态封装，无需测试 |
| `PhaseState.lastTagResult` 存储 | 简单字段赋值，无需测试 |

---

## 7. 验收标准

1. 保存 2 个标签不同的预设后，输入一张参考图 → `assess_lighting` → `tagResult` 出现在返回 JSON 中
2. 若参考图标签与预设 A 的 3/5 维度匹配且 score >= 0.5 → `before_agent_start` 注入包含预设 A
3. 若参考图标签与预设 A 仅 1/5 维度匹配 → 不注入
4. 第 3 次 `assess_lighting` 后不注入（即使有匹配预设）
5. `_activeReferencePath` 默认 `null`，getter/setter 正常工作

---

## 8. 与后续 Issue 的接口

| 元素 | 后续使用者 |
|------|------|
| `matchPresetsByTags()` | 仅 008c |
| `buildPresetSuggestion()` | 仅 008c |
| `_activeReferencePath` | 008d（load_preset 设置它）, 已有 assess_lighting/check_dimension（读取它做默认 reference_path） |
| `PhaseState.lastTagResult` | 008f（TAG_REVIEW 中断判断也用此字段） |
