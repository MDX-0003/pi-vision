# Handoff — Issue 008 预设系统 v2 设计讨论总结

**日期**: 2026-08-11
**状态**: PRD 定稿，5 个确认点已全部决议，可开工 008a
**PRD**: [docs/issue-008-preset-system.md](../issue-008-preset-system.md)
**替代**: [0810-preset-system-design.md](./0810-preset-system-design.md)（已废弃）

---

## 1. 六项已确认决议

### 1.1 参考图分析：两次 Vision 调用，分开

`ATMOSPHERE_ANALYSIS_PROMPT`（8 维 rating）和 `buildTaggingPrompt()`（标签）各自独立调用但并行发出。Wall-clock 时间不受影响，prompt 各自精简，解析失败可独立重试。

### 1.2 save_preset 同名覆盖：方案 B（报错 + 提示 LLM）

不加 `overwrite` 参数。首次调用遇到同名 → 返回错误 `{ success: false, error: "预设已存在..." }` → LLM 向用户确认 → 用户确认后 `delete_preset + save_preset`。不使用二次调用确认模式，工具签名保持简洁。

### 1.3 注入停止条件：`assessCount <= 2`

前两次 `assess_lighting` 调用后注入预设匹配建议。第三次起不再注入（LLM 已知预设列表，避免重复）。

### 1.4 color_palette: `mixed` → `warm_cool_contrast`

消除歧义——Vision 能明确理解 `warm_cool_contrast` = 画面不同区域存在明显色温差异（暖高光 + 冷阴影）。

### 1.5 运行时标签校验：Phase 1 静默降级 + 别名映射（008a）

- `validateTags()` 在 `analyzeAndTag()` 内部做校验
- 非法值 → 查 `tag-aliases.json` → 命中则静默转换
- 未命中 → 降级为 `unspecified`，记录到 `validation.unknownTags`
- 不中断流程

### 1.6 TAG_REVIEW 中断 + 词汇表扩展：远期 008f（已完整规划，不立即执行）

- 新增 `TAG_REVIEW` Phase
- 新增 `approve_tag` / `reject_tag` / `reanalyze_preset` 工具
- `approve_tag` 写入 `tag-vocabulary.json`（只增不减），`addCustomTag()` 内存立即生效
- 两者都能解除 guard，LLM 必须向用户确认后才能调用
- `PresetTags` 类型保持 `string`（非字面量联合），运行时 `isValidTagValue()` 保底
- `buildTaggingPrompt()` 动态合并 `BASE_TAG_VALUES + tag-vocabulary.json`
- `approve_tag` 返回 `affected_presets` 提示哪些预设标签可能陈旧

---

## 2. 词汇表扩展 → 参考图标签生成 → 预设匹配 的时序保证

三者在同一进程、同一事件循环中顺序执行。`addCustomTag()` 更新模块级变量 `_customVocabulary`，后续 `buildTaggingPrompt()` 立即读到最新值。JavaScript 单线程事件循环天然保证无 gap。无需任何同步原语。

---

## 3. 可复用架构关键约束

1. `PresetTags` 仅 `vision/analyzer.ts` 定义 —— `presets/types.ts` 导入，不重复
2. `BASE_TAG_VALUES` 仅 `vision/analyzer.ts` 定义 —— 类型约束 + Prompt 生成 + 校验的数据源
3. `getEffectiveVocabulary()` 是词汇合并的唯一入口 —— 所有需要词汇列表的地方统一调用
4. `buildTaggingPrompt()` 每次调用时即时生成 —— 不缓存、不预编译
5. `analyzeAndTag()` 是"图片 → 标签"的唯一入口 —— 参考图分析和截图分析复用
6. `_activeReferencePath` 仅 `state.ts` 维护 —— 不分散到多个模块

---

## 4. 实施 Issue 总览

| Issue | 内容 | 预计 |
|:--:|------|:--:|
| **008a** | 标签分析器 + 类型 + 存储 | 1.5 天 |
| **008b** | 场景快照 + save/list/delete 工具 | 1.5 天 |
| **008c** | 标签匹配 + before_agent_start 注入 | 1 天 |
| **008d** | 属性应用 + load_preset 工具 | 1.5 天 |
| **008e** | 测试 + 边界条件 | 1 天 |
| *008f* | *TAG_REVIEW + 词汇表扩展（远期）* | *2 天* |

008a → 008b 并行 008c（共享 008a，互不依赖）→ 008d → 008e

---

## 5. 相关 Commit

| Commit | 内容 |
|------|------|
| `63fecea` | Issue 008 初始 PRD（v1） |
| `3844bf7` | v1 修订：去掉 description（后被推翻） |
| `d92705f` | v1 修订：恢复 description + 双门控匹配 |
| `6afa722` | v1 handoff：预设系统设计状态 |
| *本 handoff* | v2 设计定稿：截图 ground truth + 标签匹配 + 可扩展词汇表 |
