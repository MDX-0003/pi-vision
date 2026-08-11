# Issue 008e — 测试 + 边界条件

**状态**: 待开工
**依赖**: 008a-008d 全部完成
**预计**: 1 天
**PRD**: [docs/issue-008-preset-system.md](../../issue-008-preset-system.md)

---

## 1. 目标

对预设系统的全部 4 个工具 + 匹配引擎 + 注入逻辑做集成测试和边界条件覆盖。

---

## 2. 依赖

- 008a-008d 全部功能就绪
- 已有测试框架：`test/verify-converter.mjs` 使用的 `node --experimental-vm-modules` 模式

---

## 3. 产出文件

| 文件 | 操作 | 内容 |
|------|:--:|------|
| `packages/ue-harness/test/presets-match.test.ts` | N | `matchPresetsByTags()` 单元测试 |
| `packages/ue-harness/test/presets-store.test.ts` | N | store CRUD 测试 |
| `packages/ue-harness/test/presets-validation.test.ts` | N | `validateTags()` 测试 |
| `packages/ue-harness/src/presets/*.ts` | E | 各文件的边界条件处理补充 |

---

## 4. 详细规格

### 4.1 `matchPresetsByTags()` 单元测试

```typescript
// test/presets-match.test.ts
// 测试覆盖：

// Case 1: 完美匹配（5/5）
//   预设: { golden_hour, warm, heavy_fog, low_angle, dramatic }
//   查询: 同上 → score ≈ 1.0

// Case 2: 部分匹配（3/5）
//   预设: { golden_hour, warm, heavy_fog, low_angle, dramatic }
//   查询: { golden_hour, warm, clear, top, dramatic }
//   comparable=5, hits=3 → controlledScore=0.6 → score >= 0.5

// Case 3: 双方各有 unspecified
//   预设: { golden_hour, warm, unspecified, low_angle, dramatic }
//   查询: { golden_hour, unspecified, heavy_fog, low_angle, bright }
//   comparable=3 (time_of_day, light_direction, mood)
//   hits=2 (time_of_day, light_direction) → controlledScore=0.67

// Case 4: comparable < 2
//   预设: { golden_hour, unspecified, unspecified, unspecified, unspecified }
//   查询: { dusk, unspecified, unspecified, unspecified, unspecified }
//   comparable=1 (< 2) → 不匹配

// Case 5: 全 unspecified
//   预设: { unspecified, unspecified, unspecified, unspecified, unspecified }
//   查询: { unspecified, unspecified, unspecified, unspecified, unspecified }
//   comparable=0 → 不匹配

// Case 6: 自由标签加分
//   查询: ["ocean", "god_rays"], 预设: ["ocean", "silhouette"]
//   intersection=1, union=3 → freeformScore=0.33 → *0.15 = +0.05

// Case 7: 空自由标签
//   查询: [], 预设: ["ocean"]
//   intersection=0, union=1 → freeformScore=0

// Case 8: 多预设排序 → 取 top-3
```

### 4.2 store CRUD 测试

```typescript
// test/presets-store.test.ts
// 测试覆盖：

// Case 1: savePresetEntry + loadPresetEntry 往返
//   写入 → 读取 → PresetEntry 字段完全一致

// Case 2: loadAllPresets 返回所有合法预设
//   创建 3 个预设 → loadAllPresets().length === 3

// Case 3: 损坏 JSON 被跳过
//   手动写入一个非 JSON 文件 → loadAllPresets() 不包含它

// Case 4: deletePresetDir 完整删除
//   delete → presetExists === false, preset.json 不存在

// Case 5: presetExists 正确识别
//   不存在的名称 → false, 存在的名称 → true

// Case 6: findPresetsByTagValue 定位旧标签
//   多个预设使用 "golden_hour" → 返回列表包含所有匹配的预设名
```

### 4.3 `validateTags()` 测试

```typescript
// test/presets-validation.test.ts
// 测试覆盖：

// Case 1: 全部合法值 → isValid: true, unknownTags: []
// Case 2: 一个非法值 → isValid: false, unknownTags: [{dim, value}]
//    对应维度降级为 "unspecified"
// Case 3: 别名映射 → "sunset" → alias → "golden_hour" → isValid: true
// Case 4: 缺少维度 → 补 "unspecified"
// Case 5: freeformTags 非数组 → 降级为 []
```

### 4.4 边界条件补充（PRD §10 逐项检查）

在各源文件中补充以下错误处理：

| 场景 | 文件 | 处理 |
|------|------|------|
| save_preset 场景无氛围组件 | `capture.ts` | `missingActors` 列表完整，不阻断 |
| save_preset Vision API 不可用 | `tools.ts` | 已通过 getVisionClient().isConfigured 检测 |
| save_preset 截图失败 | `tools.ts` | `captureViewport` 返回 null → 报错 |
| 预设 JSON 损坏 | `store.ts` | `loadPresetEntry` try/catch 返回 null |
| load_preset actor 缺失 | `apply.ts` | try/catch per actor → skipped |
| load_preset 属性部分失败 | `apply.ts` | `result.isError` 检测 → skipped |
| 匹配时无预设 | `match.ts` | 空数组输入 → 空数组输出 |
| 匹配分接近 | `match.ts` | 排序确定性（分数相同时按 name 字母序固定） |
| `tag-vocabulary.json` 首次不存在 | `analyzer.ts` | `loadCustomVocabulary` try/catch |

---

## 5. 验收标准

1. `matchPresetsByTags()` 至少 8 个测试用例全部通过
2. store CRUD 至少 6 个测试用例全部通过
3. `validateTags()` 至少 5 个测试用例全部通过
4. 保存 → 加载 → assess_lighting（自动 `_activeReferencePath`）端到端流程可手动执行
5. 所有 PRD §10 边界条件表已覆盖

---

## 6. 与后续 Issue 的接口

008e 是整个 008 系列的收尾，产出是稳定的测试覆盖和边界处理。008f 在此基础上新增 TAG_REVIEW 流程，所有已有测试不应被破坏。
