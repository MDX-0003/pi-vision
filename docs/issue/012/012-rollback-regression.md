# Issue 012 — 回归检测 + 回滚通道修复

**状态**: Active（2026-08-14 开工，方向决策已确认）
**前置**: Issue 012 核心已完成（commit `ac0dbc7db` + `96129369a`）——停滞检测三信号 / 写前读 journal / 回滚 / 方向 tier
**Handoff**: [docs/handoff/0814-issue-012-tier-convergence.md](../../handoff/0814-issue-012-tier-convergence.md)（含审阅补充 §4.4 / §4.5）
**来源**: 代码审阅 handoff 后的修改意见（2026-08-14，用户确认按此开发）

## 已确认的方向决策（2026-08-14）

| 决策 | 结论 | 影响 |
|---|---|---|
| 回归触发后的动作 | **回滚后留在本 tier 重试一次**：回归视为「一笔误操作」而非「阶段调不出来」。每 tier 回滚次数上限 1，第二次回归才强制推进 | 子任务 3 重写：regression 独立于 detectStall，不直接 advanceTier |
| 实机 smoke test | 本期交付代码 + 单测 + **诊断脚本**，用户在 UE 环境跑 | 新增子任务 6 |
| 回归阈值 | 默认 `luminanceDeltaPct 恶化 >15pp` 且 `deltaE_mean 恶化 >3`（AND），基于 session_analysis.md 真实数据推导（正常轮 deltaPct 7-12%，崩溃轮 -27.7%；deltaE 正常 16-17、崩溃 21.7），实机后校准 | 子任务 3 常量值 |

---

## 动机

### 1. 回归信号缺失（核心）

两次实机 session 暴露：LLM 在 autoExposureBias 上「单调调过头再回撤」——迭代 13 设 `autoExposureBias=-0.15` → 亮度崩 27.7%，随后 LLM 花 3 轮手动 `-0.03 → 0 → bOverride=false` 修回来。

现有三个停滞信号（round_cap / plateau / oscillation）都抓不住这类事件（详见 handoff §2.3 对照表）：它不是震荡，是**单调漂移**。缺的是一个**回归信号**：比较当前定量指标（来自每次 assess_lighting 的截图）与 bestRound 的历史最佳，明显变差 → 回退。

### 2. 回滚通道 bug（审阅发现）

`applyRollback` 对所有非 transform 写一律走 `properties` 通道，但 PPV 的写是 `values` 通道（JSON 字符串、settings struct 整体写回）。memory 已记录：**PPV settings 走 properties 通道会静默失败（不报错、值不生效）**。且 `!r.isError` 判定成功会把失败记成「已回滚」。

autoExposureBias 恰好是 PPV settings 字段、恰好是最该触发回滚的案例——**实机第一次触发回滚就会撞上这条路径**。纯逻辑测试抓不到（computeRollbackWrites 只产出 props 对象，不带通道信息）。

### 3. 两层回滚的分工（不是取舍）

| | 写前读 journal（已实现） | 定量回归（本 issue） |
|---|---|---|
| 层级 | 参数空间（写级） | 结果空间（轮级） |
| 回答 | 怎么回退 | 该不该回退 |
| 判断 | 无 | 有 |

journal 是**执行器**，回归信号是**判断器**，二者互补。指标成本近零：`extractQuantSnapshot`（index.ts:384）已在每次 assess 计算，回归只是比较快照，零新增截图、零新增 Vision 调用。

---

## 子任务

### 1. JournalEntry 加 channel 字段 + applyRollback 按通道写回（先做，依赖项）

```typescript
// phase-machine.ts — JournalEntry
export type WriteChannel = "properties" | "values" | "transform";
export interface JournalEntry {
  refPath: string;
  prop: string;
  from: unknown;
  to: unknown;
  channel: WriteChannel;  // 新增：写时走的通道
}
```

- `capturePreWrite`：根据 `params.properties`（object）vs `params.values`（JSON 字符串）判定通道，填入 entry
- `captureTransformPreWrite`：固定 `channel: "transform"`
- `applyRollback`：按 `w.channel` 分派（**2026-08-14 实机验证后的最终形状**）
  - `transform` → `set_actor_transform` + `{ actor: { refPath }, xform: w.props.transform }`（参数名是 **xform**，不是 transform）
  - `values` / `properties` → `set_properties` + `{ instance: { refPath }, values: JSON.stringify(w.props) }`（**实机 schema 只有 values 通道**，无 properties 参数）
- `computeRollbackWrites` 合并逻辑不变，按 channel 分组（同 refPath 同 prop 不同通道的写，取 mark 后第一次的 from）

**实机验证结论（2026-08-14，smoke test）**：
- set_properties schema = `{ instance, values: string }`（required），常规组件 `values: '{"intensity":6}'`、PPV `values: '{"settings":{...}}'` 均实测生效
- set_actor_transform 参数名 **xform**，rotation 字段为**小写** pitch/yaw/roll（journal 的 from 值整体往返，无需改大小写）
- 旧写法（`properties` object / `transform`）实机返回 server_error——**apply.ts（008d 预设应用）与旧 applyRollback 的写路径从未在实机生效过，本 issue 一并修复 apply.ts**

### 2. bestRound 加定量快照

```typescript
// phase-machine.ts — bestRound 扩展（只加字段，不改更新条件，见 Q1）
bestRound: {
  assessIndex: number;
  closeEnoughCount: number;
  needsAdjustmentCount: number;
  overall: string;
  journalMark: number;
  quant: {                       // 新增：该轮的定量快照
    luminanceDeltaPct: number;   // 当前轮 vs 参考图 的亮度偏差
    deltaE_mean: number;         // 平均色差
  };
} | null;
```

- `trackBestRound` 签名加 `quantSnapshot` 参数，刷新 best 时一并存储
- 更新条件**不变**（close_enough 数量严格递增）——回归基准 = "LLM 自己认为最好的轮"
- 不能依赖 `quantitativeSnapshots`（只存最近 3 轮，可能被 shift 掉），bestRound 必须自带快照

### 3. regression 信号（核心，按已确认决策）

**语义**：回归 = 「一笔误操作恢复」，不是「阶段结束」。触发后**回滚但不推进**，留在本 tier 重试；每 tier 回滚次数上限 `REGRESSION_MAX_ROLLBACKS = 1`，达到上限后再次回归 → 回滚 + 强制推进。

```typescript
// phase-machine.ts
export const REGRESSION_LUM_DELTA_PP = 15;  // 亮度偏差恶化阈值（百分点），用户确认默认值
export const REGRESSION_DELTAE = 3;          // deltaE_mean 恶化阈值
export const REGRESSION_MAX_ROLLBACKS = 1;   // 每 tier 最多回滚重试次数

// PhaseState 新增
rollbackCount: number;  // 本 tier 已触发回归回滚的次数（resetTierProgress 清零）

function detectRegression(state: PhaseState): boolean {
  const best = state.bestRound;
  const cur = state.quantitativeSnapshots.at(-1);
  if (!best?.quant || !cur) return false;    // 首轮无 bestRound 天然不触发
  const lumWorse = cur.luminanceDeltaPct - best.quant.luminanceDeltaPct > REGRESSION_LUM_DELTA_PP;
  const deWorse = cur.deltaE_mean - best.quant.deltaE_mean > REGRESSION_DELTAE;
  return lumWorse && deWorse;                // 主次信号 AND（Q2）
}
```

**onAssessLighting 分支（TUNING 内，顺序）**：

```
1. allClosed → advanceTier（正常收敛）
2. detectStall（round_cap/plateau/oscillation）→ 回滚 + advanceTier（原有路径不变）
3. detectRegression → 回滚 + 留在本 tier：
   - rollbackCount++；bestRound 重置为当前轮（journalMark = changeJournal.length，新基线）
   - 若 rollbackCount > REGRESSION_MAX_ROLLBACKS → 改为回滚 + advanceTier
```

- StallKind 加 `"regression"`，lastStall 注入文案区分「已回滚，继续本 tier」/「已回滚，进入下一阶段」
- 回滚写（applyRollback 的 set_properties）**不进 journal**（index.ts 直接调 MCP，不经过 recordWrite）——天然正确
- 防循环：bestRound 重置 + journalMark 前移，后续回归只比较新基线之后的新写

### 4. 测试

**verify-issue-012-convergence.ts 扩展**（按新语义）：

```
1. 回归触发（首次）: bestRound.quant lum=10 → 下一轮 lum=25 → regression →
   pendingRollback 非空 + tier 不变 + rollbackCount=1 + bestRound 重置（journalMark 前移）
2. 回归再触发（第二次）: 重置基线后再次恶化 → 回滚 + tier 推进（rollbackCount > 上限）
3. 改善不触发: 下一轮 lum=8（变好）→ 不停滞
4. 无 bestRound 不触发: 首轮 → 不停滞
5. 阈值内小波动不触发: lum 恶化 5pp（< 15）→ 不停滞
```

**新增 test/rollback-channel.test.ts**（mock UeClient.callToolWithRetry，断言 applyRollback 按通道选工具和参数形状）：

```
- channel=transform → set_actor_transform + { actor, transform }
- channel=values → set_properties + { instance, values: JSON.stringify(...) }
- channel=properties → set_properties + { instance, properties }
- isError=true → 不计入 applied，不误报"已回滚"
```

运行方式同现有：`node --import tsx test/<file>.ts`（packages/ue-harness 目录）。

### 5. 实机 smoke test（用户在 UE 环境跑，脚本见子任务 6）

回归会让回滚第一次在实机真正执行——必须先验证执行器本身。验证 4 条 UE 写路径：

1. `get_properties` 读标量值（from 记录正确）
2. `properties` 通道回滚写（DirectionalLight 等常规组件）
3. `set_actor_transform` 旋转（方向 tier）
4. `values` 通道回滚写（PPV settings，三步流程：读 settings → 改字段+bOverride → values JSON 写回）

### 6. 实机诊断脚本（本期交付，用户在 UE 环境跑）

仿 010c 的 diag 风格（`test/presets-010c-capture-diag.ts`），新建 `test/rollback-diag.ts`：

```
[DIAG] === rollback channel diagnostic ===
[DIAG] Connected to UE MCP at http://localhost:8000/mcp
[DIAG] --- properties 通道 ---
[DIAG]   set DirectionalLight.intensity = 5 → get_properties 读回 = 5 ✓
[DIAG] --- transform 通道 ---
[DIAG]   set_actor_transform yaw=45 → get_actor_transform 读回 = 45 ✓
[DIAG] --- values 通道（PPV）---
[DIAG]   get_properties(["settings"]) → 读回 struct 字段名: WhiteTemp, ColorSaturation...
[DIAG]   values 写回 { settings: {...} } → get_properties 读回确认生效 ✓
```

目标：验证 from 值可写回（字段名大小写一致）、三种通道参数形状正确。

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/workflow/phase-machine.ts` | JournalEntry 加 channel；bestRound 加 quant；PhaseState 加 rollbackCount；detectRegression + 常量；onAssessLighting 回归分支；StallKind 加 "regression" |
| `src/index.ts` | capturePreWrite / captureTransformPreWrite 填 channel；applyRollback 按通道分派 |
| `src/workflow/injections.ts` | lastStall 文案适配 regression（已回滚继续 / 已回滚推进） |
| `test/verify-issue-012-convergence.ts` | 扩展 5 个 regression 用例 |
| `test/rollback-channel.test.ts` | **新建**：applyRollback 通道 mock 测试 |
| `test/rollback-diag.ts` | **新建**：实机诊断脚本（用户在 UE 环境跑） |

## 非本期范围

- 收紧阈值（震荡扩展 struct 字段、plateau 移动窗口、round_cap 下调 5-6）——对单调漂移无用，降级
- bestRound 改为定量最优定义（Q1 否决）
- Vision re-rank（011 遗留）
