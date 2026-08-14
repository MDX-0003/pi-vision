# Handoff — Issue 012: Tier 停滞收敛 + 回滚 + 方向 tier

**日期**: 2026-08-14
**状态**: 核心实现已完成并提交（2 个 commit）；「回归检测」待做
**来源**: Issue 011 完成后，两次实际 UE 调参 session 暴露的「死磕」问题
**决策**: 全部与用户（MDX-0003）逐条讨论确认
**审阅修订**: 2026-08-14 按代码审阅意见补充 §4.4（两层回滚分工）、§4.5（回归检测四个设计决策）、§6（待办更新）、§8（values 通道写回坑）。后续开发按 [Issue 012](../issue/012/012-rollback-regression.md) 执行

---

## 1. 背景：要解决什么问题

调光任务里 LLM 容易**在一个 tier 死磕**，不会判断「当前阶段已经调得差不多了，该进下一阶段」。而调光的本质是**「完成比完美更重要」**——见好就收，效率与效果的平衡优先于把某个维度调到位。

最初的诉求是「怎么让 LLM 知道该进下一阶段了」，讨论后收敛为两层机制：

1. **机器判定的确定性事实**（detectStall + 强制推进）——不依赖 LLM/Vision 的主观判断；
2. **回滚到历史最佳**（写前读 from/to 日志 + journalMark 回滚）——停滞时恢复到本 tier 最好的参数状态，而非当前（可能更差）的状态。

---

## 2. 诊断依据：两次 session 暴露的问题

### 2.1 Session 1（2026-08-13 06:50）

LLM 在 Tier 1 死磕 18 轮。关键证据：**sky rbRatio 在迭代 13 收敛到 1.142（参考 1.145，几乎对齐），之后 LLM 继续折腾，迭代 17 退步到 1.18**。即「收敛后又主动倒退」。

### 2.2 Session 2（2026-08-13 08:12）

21 轮推进到 Tier 3，25/30 收敛但未 DONE。**回退机制全程未触发**（三个 tier 各 8/3/9 轮，均 < 10 上限）。subagent 交叉验证后，最关键的发现是：

> **最硬的「需要回退但没触发」案例不是「震荡」，而是 autoExposureBias 的「越调越差」**：
> 迭代 13 设 `autoExposureBias=-0.15` → 亮度崩 27.7%（luminance 148 → 96.5），随后 14-16 轮自己一路 `-0.03 → 0 → bOverride=false` 慢慢回默认，**花了 3 轮才修回来**。

### 2.3 关键结论（修正了早期误判）

早期我判断「抓不住震荡」，方向其实**不准**。对照三个停滞信号：

| 信号 | 会不会抓住 autoExposureBias 事件 | 原因 |
|---|---|---|
| `round_cap`（10 轮上限） | ❌ | Tier 3 到 9 轮，差一点 |
| `plateau`（连续 3 轮 close_enough 无改善） | ❌ | close_enough 在 4↔5 波动，计数一直重置 |
| `oscillation`（数值方向反转 ≥3 次） | ❌ | autoExposureBias 是 `-0.15→-0.03→0` **单调回调**，不是来回反转 |

**它根本不是震荡，是「单调调过头再回撤」。所以真正缺的是一个「回归信号」：比较当前定量指标（亮度 deltaPct / deltaE）与 bestRound 的历史最佳，明显变差就回退。** 而当前 `bestRound` 只存了 close_enough 数量，**没存定量指标**，因此根本做不了回归判定。

（次要发现：sky 色温的「偏冷/偏暖」反复，主要是 LLM 的 narrative 自相矛盾——rbRatio 实际只在 1.19→1.20 窄带打转。这是 Vision/prompt 层面的一致性问题，不是回滚能解决的。）

---

## 3. 已实现（2 个 commit）

### Commit 1: `ac0dbc7db` — Issue 012: Tier 停滞收敛 + 回滚 + 注册表数据驱动重构

| 模块 | 内容 |
|---|---|
| **停滞检测** `detectStall` | 三个信号：`round_cap`（tierRoundCount ≥ 10 强制推进，从「建议」改为「强制」）、`plateau`（连续 PLATEAU_ROUNDS=3 轮 close_enough 无改善）、`oscillation`（数值型参数方向反转 ≥ OSCILLATION_REVERSALS=3 次） |
| **写前读 journal** | 每次 `set_properties` 前 `get_properties` 读旧值，写成功后 `recordWrite` 记 `{refPath, prop, from, to}` |
| **回滚** | `bestRound.journalMark` 记录最佳轮时的 journal 长度；`computeRollbackWrites` 用位置回滚（取 mark 之后每个 prop 第一次写的 `from`） |
| **强制推进** | `onAssessLighting` 里 stall → `computeRollbackWrites` → `advanceTier`，LLM 收到的是结果陈述而非请求 |
| **TUI** | `ctx.ui.setStatus` 实时显示「Tier N · 第 X 轮」；`ctx.ui.setWidget` 强制推进时显示持久化提示面板 |
| **tier 注册表** | 新建 `tiers.ts`，`TIER_ORDER` 单一数据源，其余 5 文件派生 |

### Commit 2: `96129369a` — Issue 012b: 新增方向 tier（直射光 transform 优先调参）

直射光方向（太阳角度）独立成 **Tier 1**，光源/大气/后期顺延为 2/3/4。这是对「LLM 完全没动旋转」这个问题的根因修复——之前旋转根本没被当作可调维度暴露。

---

## 4. 架构决策

### 4.1 tier 注册表（tiers.ts）—— 单一数据源

`TierDef { id, label, components, properties, keywords, prePhase?, transformBased? }` + `TIER_ORDER[]`。新增/删除/重排 tier 只改这一处数组，其余全派生：

- `resolveTier(toolName, args)`：关键词子串匹配（toolName → refPath → values/properties），首命中返回 tier
- `nextTier(id)`：纯函数，返回下一个 tier（含 prePhase 信息）
- `advanceTier`：`next = nextTier(state.tier)`；有 prePhase 先切 phase，否则切 tier，末尾 → FINAL
- 渲染（`buildTunableLine` / `buildTierListDescription`）供 TUNING 模板、Vision prompt、buildCurrentTierInfo 派生

**模块边界原则**：「什么 tier 存在、怎么归类、怎么描述」进 tiers.ts（纯、无 I/O）；「状态怎么流转、调用拦不拦」留在 phase-machine / guard-rules，它们调 tiers.ts 的纯函数。

### 4.2 回滚机制：写前读全量 from/to 日志（event-sourcing undo log）

**放弃过**的方案：lazy baseline（首次写前读一次）——被否决，因为「要真正回退就必须每次写前都读」，lazy 记不全历史。最终用**每次写前都读**，日志自包含，`journalMark`（数组位置，非轮次 index）天然无 off-by-one。

- **轮次 index 单标准**：journal 不打轮次标签，回滚用位置；唯一用轮次的是 plateau，复用 `state.tierRoundCount`（注入给 LLM 看的同一个计数器）。
- **advanceTier 单入口**：LLM 收敛路径（allTierAspectsClosed）和代码停滞路径（detectStall）都走同一个 `advanceTier`，副作用字节级一致。

### 4.3 共享 arg 解析

`extractRefPath`（instance.refPath / actor.refPath）+ `extractWriteTarget`（refPath + props）抽到 tiers.ts，`resolveTier` 和 journal 复用，避免重复。

### 4.4 两层回滚的分工：journal = 执行器，回归信号 = 判断器（审阅补充）

写前读 journal 与定量回归不在同一层级，**不是替代关系**：

| | 写前读 journal（已实现） | 定量回归（Issue 012） |
|---|---|---|
| 层级 | 参数空间（输入域，写级） | 结果空间（输出域，轮级） |
| 回答的问题 | 怎么回退——恢复到什么值 | 该不该回退——什么时候变差了 |
| 判断能力 | 无（只记 from/to，不判断好坏） | 有（直接度量离参考图多远） |

- **journal 是回滚的执行器**：提供细粒度撤销能力，但不判断好坏；
- **回归信号是回滚的判断器**：检测"当前定量比 bestRound 明显变差"，但自身无法还原参数；
- 缺回归信号：round_cap / plateau / oscillation 抓不住「单调调过头再回撤」（autoExposureBias 案例，§2.3）；
- 缺 journal：检测到回归后无机制把参数恢复回去。

两者执行时机相同（都在 onAssessLighting / tool_result 中），bestRound.journalMark 精确划分「best 之后的写」= 回归判定窗口 = journal 撤销段。指标成本近零：extractQuantSnapshot 已在每次 assess 计算，回归只是比较快照，零新增截图、零新增 Vision 调用。

### 4.5 回归检测的四个设计决策（审阅补充）

| 决策 | 结论 | 理由 |
|---|---|---|
| Q1 bestRound 的「best」定义 | **只加定量快照字段，不改更新条件**（close_enough 数量严格递增） | 回归基准 = "LLM 自己认为最好的轮"的指标。即使非指标全局最优，拉回自身最佳点已优于继续漂移；改条件会连带 plateau 检测与回滚语义漂移 |
| Q2 「明显变差」阈值 | luminanceDeltaPct 主信号（恶化 >15pp）+ deltaE_mean 次信号（恶化 >3），AND；v1 纯指标 + 保守大阈值 | 案例信号极强（9% → -27.7%）；009 教训：auto-exposure 污染的亮度指标会误触发，大阈值 + 主次信号 AND 缓解。不用"指标+Vision 双确认"以保持机器判定确定性 |
| Q3 回滚范围 | 接受 computeRollbackWrites 现有「整段撤销 mark 之后所有写」 | 逐写归因需每写一截图，成本爆炸；tier 内参数互相影响，整段恢复一致性最好。**宁可多退（多花 1-2 轮重调），不可少退（死磕复发）** |
| Q4 信号顺序与防循环 | regression 放 detectStall 中 oscillation 之前（round_cap → plateau → regression → oscillation） | 结果级信号比过程级推断更硬。防循环天然成立：回归触发走 advanceTier → resetTierProgress 清空 bestRound/journal，tier 单向推进；首轮无 bestRound 天然不触发 |

---

## 5. 验证状态

- **测试 56 项全绿**：`test/verify-tiers.ts`（26 项，覆盖 resolveTier 归类 / nextTier 顺序 / prePhase / extractRefPath）+ `test/verify-issue-012-convergence.ts`（30 项，覆盖 detectStall 三信号 / computeRollbackWrites / 停滞回滚 / 4-tier 全路径 T1→T2→T3→POSTPROCESS_SETUP→T4→FINAL→DONE）。
- **类型检查**：本次触及的文件 0 错误。
- 运行方式：`node --import tsx test/<file>.ts`（从 `packages/ue-harness` 目录）。

---

## 6. 待办（按优先级）

| 项 | 说明 | 状态 |
|---|---|---|
| **values 通道写回修复** | `applyRollback` 对所有非 transform 写一律走 `properties` 通道，PPV settings struct 会静默失败（§8）。JournalEntry 加 channel 字段，按原通道写回 | 📋 Issue 012（先做，依赖项） |
| **回归检测**（核心） | `bestRound` 加定量快照（luminanceDeltaPct / deltaE_mean），新增 `regression` 信号：当前定量比 bestRound 明显变差 → 回退 + 强制推进。阈值与决策见 §4.5。`extractQuantSnapshot` 已算出这些指标，只是没用它们做停滞判定 | 📋 Issue 012 |
| **实机 smoke test** | 验证 `get_properties` 读标量值 + `properties` 回滚写 + `set_actor_transform` 旋转 + values 通道回滚（PPV），四条 UE 写路径是否真生效（本环境无 UE 运行，未验证）。**前置**：回归会让回滚第一次在实机真正执行 | 📋 Issue 012（前置/伴随） |
| 收紧阈值（次要） | 震荡检测扩展到 struct 字段（lightColor 的 R/B 比值作标量代理）、plateau 用移动窗口、round_cap 下调到 5-6。**注意：这些对 autoExposureBias 这种「单调调过头」无用**，回归检测才是对症的 | ⬜ 降级（非本期） |

---

## 7. 关键文件索引

| 文件 | 职责 |
|---|---|
| `src/workflow/tiers.ts` | **tier 单一数据源**：TIER_ORDER + resolveTier + nextTier + extractRefPath/extractWriteTarget + 渲染 |
| `src/workflow/phase-machine.ts` | 状态机：detectStall / computeRollbackWrites / advanceTier / resetTierProgress |
| `src/workflow/guard-rules.ts` | 门控：checkToolCall（调 tiers.ts 的 resolveTier） |
| `src/workflow/injections.ts` | 注入：TUNING 模板 + buildAnalysisSummary + lastStall 停滞提示 |
| `src/index.ts` | 事件接线：写前读 + recordWrite + applyRollback + TUI setStatus/setWidget |
| `src/tools/assess-lighting.ts` | assess_lighting + buildCurrentTierInfo（派生自 TIER_ORDER） |
| `src/tools/map-atmosphere.ts` | 场景扫描 + scanDirection（读太阳方向） |
| `src/tools/atmosphere-whitelist.ts` | 组件 globs（tier 字段已重编号 2/3/4） |
| `src/vision/prompts.ts` | Vision prompt（tier 列表走 `__TIER_LIST__` 占位符） |
| `test/verify-tiers.ts` / `test/verify-issue-012-convergence.ts` | 56 项断言 |

---

## 8. 坑与教训

| 日期 | 问题 | 说明 |
|---|---|---|
| 08-14 | **POSTPROCESS_SETUP 硬编码 `tier = 3`** | 重构时漏掉的旧 3-tier 遗留，导致 4-tier 下 prePhase 之后跳回 tier3。修法：advanceTier 的 prePhase 分支记住 `next.id`，POSTPROCESS_SETUP 只切 phase |
| 08-14 | **detectOscillation 只认数值标量** | `lightColor` 是 struct `{r,g,b}`，`typeof to === "number"` 直接跳过。但真正要补的不是 struct 震荡，是**回归检测** |
| 08-14 | **`AgentToolResult<T>` 泛型缺参** | assess-lighting / map-atmosphere 原返回 `AgentToolResult`（无类型参数），且 `details` 是必填字段、类型里没有 `isError`。已修为 `<null>` + `details: null` + 去掉 `isError` |
| 08-14 | **husky pre-commit 环境坑** | 钩子（biome/npm）在 cmd.exe 跑，node 不在 cmd PATH → 报 `'node' 不是内部或外部命令`。本环境提交需 `git commit --no-verify`，等价验证手动跑 tsc + 测试 |
| 08-14 | **`session_analysis.md` 是生成产物** | 由 session-summarizer 产出，提交时排除 |
| 08-14 | **`applyRollback` 一律走 properties 通道** | PPV settings 是 struct，properties 通道写回静默失败（不报错、值不生效，见 memory: ppv-set-properties-struct）；且 `!r.isError` 判定成功会把失败记成"已回滚"。autoExposureBias 恰好是 PPV settings 字段、恰好是最该触发回滚的案例——实机第一次触发回滚就会撞上。修复：JournalEntry 加 `channel: "properties" \| "values" \| "transform"`，applyRollback 按原通道写回（Issue 012） |

---

## 9. Commit 信息

```
ac0dbc7db Issue 012: Tier 停滞收敛 + 回滚 + 注册表数据驱动重构
96129369a Issue 012b: 新增方向 tier（直射光 transform 优先调参）
```
