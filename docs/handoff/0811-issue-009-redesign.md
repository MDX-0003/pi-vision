# Handoff — Issue 009: assess_lighting 串行化重构

**日期**: 2026-08-11
**状态**: PRD v3 完成（根因判定 Prompt + PostProcess 默认值重置），待确认后开工
**PRD**: [docs/issue/009/009-assess-lighting-redesign.md](../issue/009/009-assess-lighting-redesign.md) (v3)
**关联**: [Issue 008 预设系统 v2 handoff](./0811-preset-system-v2.md)

---

## 1. 背景：缘起

Issue 008 预设系统开发完成后，用户（MDX-0003）运行了一次实际调参会话。LLM（DeepSeek-v4-pro）完成 Tier 1 调参后，给出了一份详细的反馈，指出工作流存在结构性缺陷。

本 handoff 记录了从 LLM 反馈 → 问题诊断 → 方案研究 → PRD 输出的完整讨论过程。

---

## 2. LLM 反馈摘要（原始 Pi 对话）

### 2.1 LLM 的调参结果

LLM 完成了 Tier 1（CORE_LIGHTING）的调参：

| 参数 | 初始 | 调后 |
|------|------|------|
| DirectionalLight intensity | 0.45 | 0.11 |
| temperature | 6200 | 5000 |
| lightColor | (0.92,0.84,0.76) | (1.0,0.75,0.5) |
| lightSourceAngle | 0.5357 | 0.85 |
| 旋转 | -10/136/180 | -2/150/0 |
| SkyLight intensity | 0.5 | 0.12 |

Vision 判定：light_direction ✓ / shadow_depth ✓ / color_temperature ✓（但定量 delta -0.31）

### 2.2 LLM 的四个不满

**问题 1**：quantitative 与 Vision 频繁矛盾。brightness 定量从 138→158→138 波动，Vision 也在 closer/further 间摇摆，导致反复调整同一参数。

**问题 2**：被 Tier 系统卡住。brightness 无法靠 Tier 1 光源降到位（auto-exposure + 天空主导），而真正需要的 autoExposureBias（Tier 3）不让碰。post_processing 阻塞要求回退 PostProcess（Tier 3），但 guard 拦截 Tier 1 阶段改它的 set_properties。只能用 execute_tool 绕过前端校验。

**问题 3**：threshold 应引入"收敛判定"。brightness 定量已恶化到 +38% 仍报 major。建议连续 2-3 次 check 无改善时，自动判定"此维度在当前 tier 已收敛"。

**问题 4**：每 tier 开始时需要一个明确的"达标标准"。LLM 不知道 Tier 1 到底要满足什么才算完成。

### 2.3 LLM 的建议

1. 收敛止损法则：每维度只做 3-4 次迭代，2 次无改善就接受现状为 known-gap
2. check_dimension verdict 应优先于 quantitative——verdict 已 closer 就不回退
3. 明确的 tier 完成判定：当前 tier 所有维度出现过 verdict=closer 或 close_enough → 达标
4. 允许显式请求越权：blocking 维度可跨 tier 处理

---

## 3. 代码诊断：三个死锁卡点

逐行追查代码后，发现 LLM 被三段代码形成的死锁链卡住：

### 卡点 ①：[computeGap()](packages/ue-harness/src/tools/assess-lighting.ts) — 永远取最差值

```typescript
const severity = { minor: 0, moderate: 1, major: 2 };
return severity[quantGap] > severity[visionGap] ? quantGap : visionGap;
```

brightness 的 Vision rating diff = 1（→ visionGap = "minor"），但 quantitative delta +38%（→ quantGap = "major"）。代码取 max → 返回 "major"。**定量被 auto-exposure 污染后报 major，Vision 判定 closer 被无视。**

### 卡点 ②：[allTierDimsMinor()](packages/ue-harness/src/workflow/phase-machine.ts) — 一个 major 卡死全 Tier

```typescript
return gaps.filter(g => g.tier === tier).every(g => g.gap === "minor");
```

brightness 被判 major → `every(=== "minor")` → false → Tier 永远不升级。

### 卡点 ③：[guard-rules.ts](packages/ue-harness/src/workflow/guard-rules.ts) — 双重封锁

- Line 138: 跨 Tier 调参被拦截（"前置维度仍有 gap: brightness(major)，请先解决"）
- Line 163: artificiality 检测到 PostProcess 问题 → 拦截 PostProcess 写操作（"请先回退 PostProcess 到默认值"）
- "回退 PostProcess 到默认值"本身是 PostProcess 写操作 → 被同一个 guard 拦截 → catch-22

---

## 4. Pi Extension 暴露的设计问题

### 4.1 Quantitative 和 Vision 的角色混淆

当前设计中，两者作为**平行的信号源**输入 `computeGap()`，代码选择取 max。这相当于让一个不懂光照的代码函数去做"谁更可信"的判断。

**本质问题**：定量指标和 Vision rating 不在同一个评估层次上。定量测的是像素统计（受 auto-exposure、天空占比、几何内容影响），Vision 测的是感知质量。它们不是竞争关系——定量应该为 Vision 提供参考数据，而不是和 Vision 抢裁判权。

### 4.2 artificiality 是没有意义的中间概念

"检测到人工后期感"只是一个包装过的概念——本质是 Vision 在说"color_cast / saturation / contrast 不像真实光源产生的"。在新的串行架构下，Vision 看到定量数据+两张图后，可以直接在相关 aspect 的 suggestion 中说"建议回退 PostProcess color grading"，不需要一个独立的 artificiality 维度。

### 4.3 Tier 门控与 blocking 处置的矛盾

guard-rules.ts 的设计假设"blocking 维度必须先解决才能进更高 tier"，但没有考虑到 blocking 的解决方案可能涉及更高 tier 的参数。这是一个系统性的设计矛盾——blocking 需要跨 tier 操作，但跨 tier 操作被 blocking 拦截。

### 4.4 "所有维度 = minor" 的完成判据过于刚性

在定量指标被系统级因素（auto-exposure）污染的情况下，"所有维度 gap=minor"是不可达的。需要改为人性化的判断：Vision 认为 close_enough 的 aspect 不再计入 blocking。

---

## 5. 外部参考研究

### 5.1 本地 Python 脚本（`E:\Programs\UE_Project_58\MCP\Test`）

| 文件 | 关键贡献 |
|------|------|
| [compare_images.py](E:\Programs\UE_Project_58\MCP\Test\compare_images.py) | 7 类定量指标：分通道 RGB 统计、色相分布、分区域分析、亮度梯度、边缘密度、Delta E、亮度剖面 |
| [compare_atmosphere.py](E:\Programs\UE_Project_58\MCP\Test\compare_atmosphere.py) | 3 类氛围指标：分调性色温 (Shadow/Midtone/Highlight R/B)、色相×饱和度关联、CIELAB Chroma 分布 |
| [test_structural_metrics.py](E:\Programs\UE_Project_58\MCP\Test\test_structural_metrics.py) | 6 类结构性指标：3D Color EMD、Tonal R/B Gradient (10-bin)、饱和度剖面、色相多样性、曝光 Zone 分布、CIELAB a*b* 散布 |
| [validate_metrics.py](E:\Programs\UE_Project_58\MCP\Test\validate_metrics.py) | **指标验证框架**：GOOD pairs（人类认可相似）vs BAD pairs（人类不认可），验证每个指标的区分力。好指标 = GOOD pairs 值接近 + BAD pair 值明显不同 |

**关键启示**：验证框架的方法论给了我们"close_enough"的客观参照——当两个人类认可的相似图对之间某个指标的差异范围已知，就可以定义"在此范围内的差异是可接受的"。

### 5.2 网络研究

| 来源 | 关键启示 |
|------|------|
| CoT Multi-Stage IAA (IEEE 2025) | 定量/主观信号不在同一层次——定量=Low-level Stimulus，Vision=High-level Perceiving。不应让它们在同一层竞争 |
| Perceptual Ambiguity (Cheon & Lee) | 定量指标的差异存在感知上不可区分的区间。brightness +30% 不一定意味着"真的亮 30%" |
| MetaMetrics (ICLR 2025) | 校准指标的组合权重，而非全局选边站。与本设计中"每维度指定可靠信号"的思路一致 |
| Perception-Distortion Tradeoff (Blau & Michaeli) | 优化低保真度和优化感知质量常常相悖。对应：压暗 DirectionalLight → auto-exposure 补偿 → 定量恶化但感知变好 |

---

## 6. 设计演进过程

### 阶段 1：粗暴修复（被驳回）

最初提议："Vision 优先于 quantitative" 或 "quantitative 优先于 Vision"。用户驳回——这不是选边站的问题，是架构混淆了两个不同层次的信号。

### 阶段 2：多层调和（被简化）

提议"歧义区间 + Vision 振荡追踪 + 冲突诊断"的三层方案。用户指出"不是在训练模型，没有一个标准答案算 loss"，要求更务实的方案。

### 阶段 3：串行架构（当前方案）

用户的提议："把指标也作为判断依据提供给 Vision 模型，让他给出更好的调参建议"。这是最终的方向——Vision 不是和定量竞争的裁判，而是**综合定量数据+视觉判断**的决策者。代码不参与调和。

### 关键转折点

用户看到 LLM 反馈后，发现当前工作流最致命的问题不是"指标打架"，而是"Vision 不知道定量数据的存在"。串行架构从根本上解决了这个问题。

---

## 7. Issue 009 PRD 核心决策

| 决策 | 内容 |
|------|------|
| 不再有 quantitative vs Vision 的代码调和 | `computeGap()` 删除。Vision 直接看到定量数据，自己判断 |
| 删除 artificiality | 概念消失。后处理问题由 Vision 在具体 aspect 的 suggestion 中指出 |
| 删除 check_dimension | LLM 不调它，白白浪费 Vision token |
| 12 项定量指标（从 4 项扩容） | 分调性 R/B、Delta E、Chroma、分区域、Zone System 等 |
| assess 从 5 次 Vision → 2 次 | 1 次氛围（串行）+ 1 次标签（并行） |
| Tier 完成 = all aspects close_enough | 不再有 rating/gap/major/minor。Vision 说了算 |
| close_enough ≠ 完全一致 | Prompt 明确告知 Vision：见好就收 |

### 7.1 v2 新增 (2026-08-11)

| 决策 | 内容 |
|------|------|
| Tier 轮数上限 = 10，不强制推进 | `tierRoundCount >= 10` 时注入收尾提示，LLM 自行决定是否停止。正常路径 (all close_enough) 仍自动升级 |
| bestRound 追踪 | 每轮记录 close_enough 最多的那一轮，收尾提示引用"第 N 轮曾达到最佳状态" |
| 跨轮定量趋势注入 | `buildQuantitativeTrendSummary`: 最近 3 轮 Delta E / Chroma / 天空占比 / 直方图相关的趋势表格 + 阈值提示 (Delta E < 3 等) |
| 注入格式约束 | 无 emoji，符号 ([needs_adjustment] / -> / -- / 表格) 仅用于结构分层 |

### 7.2 v3 新增 (2026-08-11)

| 决策 | 内容 |
|------|------|
| Vision 的 tier 字段 = 根因判定 | 不再是"这个 aspect 属于哪个 tier 的症状分类"，而是"哪个 tier 的参数能解决此差异的根因"。如果根因超出当前 tier 的参数范围，标记 close_enough + 注明目标 tier |
| `__CURRENT_TIER_INFO__` 占位符 | Prompt 运行时注入当前 tier 编号 + 可调参数列表 + 不可调参数明示，让 Vision 了解当前阶段的调参边界 |
| SETUP 阶段 PostProcess 重置 | 首次 assess_lighting 时由扩展直接调用 UE MCP 重置 PostProcess color grading 参数到默认值。绕过 guard-rules catch-22 |
| artificiality 拦截移除 | guard-rules.ts 的 `artificialityDetected` 逻辑随旧架构删除；重置已在 SETUP 完成，Tier 3 的 PostProcess 调参是正常行为 |
| 准则 8: Delta E < 3 阈值 | Prompt 新增：当 deltaE.mean < 3 时，Vision 应对无明显视觉差异的 aspect 标记 close_enough |

---

## 8. 后续待讨论

- guard-rules.ts 的 blocking 豁免机制（用户要求"先放一放，等调参依据解决了再讨论"）
- check_dimension 删除后，是否需要一个轻量的定量-only 快速验证（"我刚改了参数，看看数变了没"）

---

## 9. 相关文件一览

### 新增

- `docs/issue/009-assess-lighting-redesign.md` — Issue 009 PRD

### 本期修改（Issue 008 + 009 集成布线）

- `src/vision/analyzer.ts` — 标签分析器（008a）
- `src/vision/prompts.ts` — `buildTaggingPrompt()`（008a）
- `src/presets/types.ts` — 预设类型（008a）
- `src/presets/store.ts` — 预设存储（008a）
- `src/presets/capture.ts` — 场景快照（008b）
- `src/presets/match.ts` — 标签匹配（008c）
- `src/presets/apply.ts` — 预设应用（008d）
- `src/presets/tools.ts` — 4 个预设工具（008b+008d）
- `src/index.ts` — 工具注册 + 事件集成（008b+008c+008d）
- `src/state.ts` — `_activeReferencePath`（008c）
- `src/workflow/phase-machine.ts` — `lastTagResult`（008c）
- `src/workflow/injections.ts` — `buildPresetSuggestion`（008c）
- `src/tools/assess-lighting.ts` — `analyzeAndTag` 并行 + `tagResult` 输出（008c）
- `test/presets-008*.mjs` — 116 个测试

### 待修改（Issue 009）

- `vision/metrics.ts` — 定量指标扩容
- `tools/assess-lighting.ts` — 串行化重写
- `vision/prompts.ts` — 新 Prompt
- `workflow/phase-machine.ts` — analysis 适配
- `workflow/injections.ts` — buildAnalysisSummary
- `tools/check-dimension.ts` — 删除
- `index.ts` — check_dimension 清理

---

## 10. Commit 信息

```
Issue 008 preset system + Issue 009 PRD
- 008a-008e: Preset system with tag-based matching (116 tests)
- Fixed: sort tiebreaker in matchPresetsByTags
- Wired: analyzeAndTag into assess_lighting flow
- Added: buildPresetSuggestion for before_agent_start
- Added: _activeReferencePath state management
- Added: Issue 009 PRD for assess_lighting serial architecture redesign
```
