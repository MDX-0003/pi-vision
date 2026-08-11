# Issue 008f — TAG_REVIEW 中断 + 运行时词汇表扩展（远期）

**状态**: 已规划，不立即实施
**依赖**: 008a-008e 全部完成
**预计**: 2 天
**PRD**: [docs/issue-008-preset-system.md](../../issue-008-preset-system.md) §14

---

## 1. 动机

Phase 1（008a）中，Vision 返回的未知标签被静默降级为 `unspecified`。当基础词汇表确实无法覆盖某些场景类型时，用户需要一个**运行时扩展词汇表**的入口——且该入口必须中断 LLM 的正常调参流程。

---

## 2. 目标

实现 TAG_REVIEW 中断机制 + `approve_tag` / `reject_tag` / `reanalyze_preset` 工具。核心保证：词汇表扩展始终在新标签生成（analyzeAndTag）和标签匹配（matchPresetsByTags）之前完成，JavaScript 单线程事件循环天然保证此顺序。

---

## 3. 依赖

- 008a：`analyzeAndTag()` 返回 `validation.unknownTags`、`addCustomTag()`、`isValidTagValue()`、`findPresetsByTagValue()`
- 008c：`PhaseState.lastTagResult`
- 已有 `phase-machine.ts` 的 Phase 类型和 guard rules 机制
- 已有 `index.ts` 的 `before_agent_start` 和 `tool_result` handler

---

## 4. 产出文件

| 文件 | 操作 | 内容 |
|------|:--:|------|
| `packages/ue-harness/src/presets/tools.ts` | E | `approveTagDef` + `rejectTagDef` + `reanalyzePresetDef` |
| `packages/ue-harness/src/workflow/phase-machine.ts` | E | Phase 新增 `"TAG_REVIEW"`, `pendingUnknownTags` 字段 |
| `packages/ue-harness/src/workflow/injections.ts` | E | `buildTagReviewContext()` |
| `packages/ue-harness/src/workflow/guard-rules.ts` | E | TAG_REVIEW 阶段白名单 |
| `packages/ue-harness/src/index.ts` | E | 注册 3 个新工具 + tool_result 触发 TAG_REVIEW |

---

## 5. 详细规格

### 5.1 触发链路

```
Turn N: LLM 调 assess_lighting
  → analyzeAndTag 返回 validation.unknownTags 非空
  → tool_result 事件中:
     if (data.tagResult.validation.unknownTags.length > 0):
       _phaseState.phase = "TAG_REVIEW"
       _phaseState.pendingUnknownTags = data.tagResult.validation.unknownTags

Turn N+1: before_agent_start 强注入 TAG_REVIEW 上下文
  → guard rules 阻止所有调参工具
  → 仅允许: approve_tag, reject_tag, list_presets, load_preset, delete_preset

LLM 调 approve_tag 或 reject_tag
  → phase → TUNING（guard 解除）
```

### 5.2 Phase 扩展

```typescript
// phase-machine.ts
type Phase = "SETUP" | "TUNING" | "POSTPROCESS_SETUP" | "TAG_REVIEW" | "FINAL" | "DONE";

interface PhaseState {
  // ... 已有字段
  pendingUnknownTags: Array<{ dimension: string; value: string }>;
}
```

### 5.3 guard 规则

```typescript
// guard-rules.ts
// 在 checkToolCall() 中新增:
if (state.phase === "TAG_REVIEW") {
  const whitelist = ["approve_tag", "reject_tag", "list_presets", "load_preset", "delete_preset"];
  if (!whitelist.includes(toolName)) {
    return {
      block: true,
      reason: "TAG_REVIEW: 必须先处理未知标签（approve_tag 或 reject_tag）。请向用户确认后选择其一。",
    };
  }
}
```

### 5.4 before_agent_start 注入

```typescript
// injections.ts
export function buildTagReviewContext(state: PhaseState): string {
  if (state.phase !== "TAG_REVIEW" || !state.pendingUnknownTags?.length) return "";

  let text = "\n## ⚠️ TAG_REVIEW: 发现未知标签\n\n";
  text += "Vision 分析返回了不在当前词汇表中的标签值:\n";

  for (const ut of state.pendingUnknownTags) {
    const dim = ut.dimension;
    const values = `（当前可选: ${/* getEffectiveVocabulary */ "..."}）`;
    text += `  ${dim}: "${ut.value}" ${values}\n`;
  }

  text += `
**请询问用户如何处理:**

A) 用户认为该标签是合理的新标签，应加入词汇表
     → 调 approve_tag('维度名', '标签值') 永久加入

B) 用户认为应回退为 unspecified
     → 调 reject_tag('维度名', '标签值') 跳过

在用户做出决定前，所有调参工具已被阻止。你必须先向用户确认，不得自行决定。
`;
  return text;
}
```

### 5.5 新增工具

| 工具 | 参数 | 行为 |
|------|------|------|
| `approve_tag` | `dimension, value` | `addCustomTag(dim, value)` → 写入 `tag-vocabulary.json` → phase → TUNING。返回 `affected_presets` |
| `reject_tag` | `dimension, value` | 不写入文件 → phase → TUNING |
| `reanalyze_preset` | `name` | 读预设截图 → `analyzeAndTag(screenshot)` → 原地更新 `preset.json` 的 tags/description/freeformTags。不动 actors |

两个 tag 工具都能解除 guard。

### 5.6 approve_tag 返回

```json
{
  "approved": true,
  "dimension": "time_of_day",
  "value": "sunset",
  "affected_presets": [
    {
      "name": "golden-hour-ocean",
      "current_tag": "golden_hour",
      "hint": "此预设的标签为旧值，建议调 reanalyze_preset('golden-hour-ocean') 更新"
    }
  ]
}
```

`affected_presets` 由 `findPresetsByTagValue(dim, "golden_hour")` 定位——找到所有使用了可能被新标签"分裂"的旧值的预设。策略：找出同一维度中与新标签**语义最接近**的基础标签值，查询使用它的预设。

### 5.7 reanalyze_preset

```
LLM 调 reanalyze_preset("golden-hour-ocean")
  → loadPresetEntry("golden-hour-ocean")
  → 读截图文件 base64
  → analyzeAndTag(vision, screenshotBase64)
  → 更新 entry.tags, entry.description, entry.freeformTags
  → savePresetEntry(entry)
  → 返回 { reanalyzed: true, oldTags: {...}, newTags: {...} }
```

不动 `entry.actors` 和 `entry.screenshot`。

---

## 6. 边界条件

| 场景 | 处理 |
|------|------|
| 多个维度同时有 unknown tags | `pendingUnknownTags` 数组包含所有维度，一次性注入全部 |
| approve_tag 传入已在基础词汇表中的值 | 不作去重（`addCustomTag` 内部 `if (!includes)` 防止重复写入） |
| reject 后同一次 assess_lighting 再次返回同一 unknown tag | 不会——phase 已回 TUNING，assess_lighting 需要再次调用才触发新的 TAG_REVIEW |
| TAG_REVIEW 期间用户想放弃调参 | LLM 可调 `reject_tag` 所有维度 → phase 回 TUNING → 正常流程继续 |
| approve_tag 后 prompt 不包含新标签 | 不会——`addCustomTag` 内存立即生效，`buildTaggingPrompt()` 动态读取 |

---

## 7. 验收标准

1. Vision 返回未知标签 → TAG_REVIEW phase 激活 → guard 阻止调参工具
2. `approve_tag('time_of_day', 'sunset')` → `tag-vocabulary.json` 包含 `sunset` → phase 回 TUNING → guard 解除
3. 下次 `assess_lighting` 时 prompt 中包含 `sunset`
4. `reject_tag` 不写入文件，phase 正常回 TUNING
5. `reanalyze_preset` 更新 preset.json 的 tags 字段，actors 不变
6. `affected_presets` 正确列出标签旧值的预设

---

## 8. 类型安全策略

`PresetTags` 字段类型保持 `string`，运行时通过 `isValidTagValue()` 校验。`BASE_TAG_VALUES` 的 `as const` 保留用于 IDE 补全。`approve_tag` 扩展词汇表不需要 TypeScript 代码变更。
