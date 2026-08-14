# Issue 012 — 回归检测 + 回滚通道修复

**状态**: Draft（计划按此开发）
**前置**: Issue 012 核心已完成（commit `ac0dbc7db` + `96129369a`）——停滞检测三信号 / 写前读 journal / 回滚 / 方向 tier
**Handoff**: [docs/handoff/0814-issue-012-tier-convergence.md](../../handoff/0814-issue-012-tier-convergence.md)（含审阅补充 §4.4 / §4.5）
**来源**: 代码审阅 handoff 后的修改意见（2026-08-14，用户确认按此开发）

---

## 动机

### 1. 回归信号缺失（核心）

两次实机 session 暴露：LLM 在 autoExposureBias 上「单调调过头再回撤」——迭代 13 设 `autoExposureBias=-0.15` → 亮度崩 27.7%，随后 LLM 花 3 轮手动 `-0.03 → 0 → bOverride=false` 修回来。

现有三个停滞信号（round_cap / plateau / oscillation）都抓不住这类事件（详见 handoff §2.3 对照表）：它不是震荡，是**单调漂移**。缺的是一个**回归信号**：比较当前定量指标（来自每次 assess_lighting 的截图）与 bestRound 的历史最佳，明显变差 → 回退 + 强制推进。

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
- `applyRollback`：按 `w.channel` 分派
  - `transform` → `set_actor_transform` + `{ actor: { refPath }, transform: w.props.transform }`
  - `values` → `set_properties` + `{ instance: { refPath }, values: JSON.stringify(w.props) }`
  - `properties` → `set_properties` + `{ instance: { refPath }, properties: w.props }`
- `computeRollbackWrites` 合并逻辑不变，按 channel 分组（同 refPath 同 prop 不同通道的写，取 mark 后第一次的 from）

**验证点（实机）**：get_properties 读回的 settings struct 字段名（PascalCase，如 WhiteTemp）与 values 写入时的字段名一致，from 值才能直接写回——参考 memory: ppv-set-properties-struct / ue-mcp-tool-naming。

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

### 3. regression 信号（核心）

```typescript
// phase-machine.ts — detectStall 新增第 4 个信号
// 顺序: round_cap → plateau → regression → oscillation（Q4）
export const REGRESSION_LUM_DELTA_PP = 15;  // 亮度偏差恶化阈值（百分点）
export const REGRESSION_DELTAE = 3;          // deltaE_mean 恶化阈值

function detectRegression(state: PhaseState): boolean {
  const best = state.bestRound;
  const cur = state.quantitativeSnapshots.at(-1);
  if (!best?.quant || !cur) return false;    // 首轮无 bestRound 天然不触发
  const lumWorse = cur.luminanceDeltaPct - best.quant.luminanceDeltaPct > REGRESSION_LUM_DELTA_PP;
  const deWorse = cur.deltaE_mean - best.quant.deltaE_mean > REGRESSION_DELTAE;
  return lumWorse && deWorse;                // 主次信号 AND（Q2）
}
```

- 触发后走现有路径：`computeRollbackWrites` → `pendingRollback` → `advanceTier`（零新增接线）
- 指标噪声防护：大阈值 + 主次信号 AND（009 的 auto-exposure 污染教训）
- 防循环天然成立：advanceTier 单向推进 + resetTierProgress 清空 bestRound/journal（Q4）
- StallKind 加 `"regression"`，lastStall 注入文案自动复用（buildInjectionAppendix）

### 4. 测试

**verify-issue-012-convergence.ts 扩展**（4 个用例）：

```
1. 回归触发: bestRound.quant lum=10 → 下一轮 lum=25 → regression → pendingRollback 非空 + tier 推进
2. 改善不触发: 下一轮 lum=8（变好）→ 不停滞
3. 无 bestRound 不触发: 首轮 → 不停滞
4. 阈值内小波动不触发: lum 恶化 5pp（< 15）→ 不停滞
```

**新增 test/rollback-channel.test.ts**（mock UeClient.callToolWithRetry，断言 applyRollback 按通道选工具和参数形状）：

```
- channel=transform → set_actor_transform + { actor, transform }
- channel=values → set_properties + { instance, values: JSON.stringify(...) }
- channel=properties → set_properties + { instance, properties }
- isError=true → 不计入 applied，不误报"已回滚"
```

运行方式同现有：`node --import tsx test/<file>.ts`（packages/ue-harness 目录）。

### 5. 实机 smoke test（前置/伴随）

回归会让回滚第一次在实机真正执行——必须先验证执行器本身。验证 4 条 UE 写路径：

1. `get_properties` 读标量值（from 记录正确）
2. `properties` 通道回滚写（DirectionalLight 等常规组件）
3. `set_actor_transform` 旋转（方向 tier）
4. `values` 通道回滚写（PPV settings，三步流程：读 settings → 改字段+bOverride → values JSON 写回）

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/workflow/phase-machine.ts` | JournalEntry 加 channel；bestRound 加 quant；detectStall 加 regression + 常量；StallKind 加 "regression" |
| `src/index.ts` | capturePreWrite / captureTransformPreWrite 填 channel；applyRollback 按通道分派 |
| `test/verify-issue-012-convergence.ts` | 扩展 4 个 regression 用例 |
| `test/rollback-channel.test.ts` | **新建**：applyRollback 通道 mock 测试 |

## 非本期范围

- 收紧阈值（震荡扩展 struct 字段、plateau 移动窗口、round_cap 下调 5-6）——对单调漂移无用，降级
- bestRound 改为定量最优定义（Q1 否决）
- Vision re-rank（011 遗留）
