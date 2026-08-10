# Issue 007 — Gap 质量增强 + 流程控制修复

**状态**: 待审阅
**优先级**: P0
**依赖**: Issue 003-005 已完成
**预计时长**: 3-5 天

---

## 1. 背景：真实测试暴露的问题

2026-08-10 进行了一次完整的参考图光照匹配测试（Pi 会话记录: `pi-session-2026-08-10T11-52-18-787Z.html`）。测试暴露了三个层面的问题：

| 层面 | 问题 | 表现 |
|------|------|------|
| **信息传递** | LLM 每轮看到的 gap 摘要只有评级（major/moderate/minor），缺少方向描述和量化数字 | LLM 不知道 color_temperature 是太冷还是太暖、差多少具体数值 |
| **交叉校验** | Vision 的 1-5 主观评分和 PIL 计算的量化指标从不互相校验 | Vision 说 brightness 差 2 分（moderate），但实际亮度只差了 15%。如果 Vision 评错，gap 就错了 |
| **流程控制** | 没有"阻塞维度"概念——某些维度不改则其他维度的调整徒劳 | 太阳角度 -49.5（高角）被评 gap=minor（diff 只有 1），Pi 合法进入 Tier 2 调雾/云，连续 3 次 further 全部回退 |

**结果**: Pi 调了 44 次工具，场景最终零改动。所有时间花在 Tier 2 参数上，而根因（light_direction）从未被解决。

---

## 2. 改造一: 量化指标集成到 Gap 判定

### 2.1 现状

```typescript
// assess-lighting.ts:106-111 — 当前 gap 分级逻辑
function computeGap(refRating: number, curRating: number) {
    const diff = Math.abs(refRating - curRating);  // 纯 Vision 1-5 评分
    if (diff >= 3) return "major";
    if (diff === 2) return "moderate";
    return "minor";
}
```

`quantitative` 数据（亮度、色温比、饱和度、直方图相关性）被放进 gap 条目的 `quantitative` 字段，但**从不参与 gap 分级**。Vision 评分和量化数字之间没有交叉校验。

### 2.2 改造方案

**2.2.1 引入量化阈值校验**

对三个有量化数据的维度（brightness, color_temperature, saturation），引入硬阈值：

```
brightness:
  delta <= 15%  → 量化判断 = minor
  delta 15-30%  → 量化判断 = moderate
  delta > 30%   → 量化判断 = major

color_temperature (R/B比):
  |delta| <= 0.15  → minor
  |delta| 0.15-0.4 → moderate
  |delta| > 0.4    → major

saturation:
  |delta| <= 0.05  → minor
  |delta| 0.05-0.15 → moderate  
  |delta| > 0.15   → major
```

伪代码:

```
computeGap(refRating, curRating, quantDelta):

  visionGap = 基于 rating diff 的 gap ← 现有逻辑
  
  如果此维度有量化数据:
    quantGap = 基于 delta 阈值的 gap
  
  最终 gap = max(visionGap, quantGap)  ← 取两者中更严重的
                                         (谁更悲观就用谁)
```

**2.2.2 直方图相关性作为整体质量信号**

直方图相关性（`histogramCorrelation`）是一个 0-1 的值，反映两张图整体色调分布相似度。单独一个维度调对但整体不像参考图的情况，这个值会很低。

```
直方图相关性 < 0.3  → 在 gap 列表末尾追加一个 pseudo-gap:
  dimension: "overall_composition"
  tier: 0 (最高优先级)
  gap: "major"
  qualitative: "画面整体色调分布与参考图差异很大。即使各维度 gap 都小，也可能有结构性不匹配（如太阳角度、场景几何）"
```

**2.2.3 数据来源**

不需要新增计算——`computeMetrics()` 已经返回了 `luminanceDelta`, `colorTempRatioDelta`, `saturationDelta`, `histogramCorrelation` 四个值。只需要在 `computeGap` 中读取它们。

### 2.3 改动点

| 文件 | 改动 | 行数 |
|------|------|:--:|
| `assess-lighting.ts` | `computeGap` 拆为 `computeVisionGap` + `computeQuantitativeGap` + `finalGap = max(vis, quant)` | ~20 |
| `assess-lighting.ts` | 新增 `computeOverallGap(histogramCorrelation)` | ~10 |

---

## 3. 改造二: Gap 摘要重构——去掉 emoji，增加维度明细

### 3.1 现状

```typescript
// injections.ts:78-95 — 当前 buildGapSummary
function buildGapSummary(state: PhaseState): string {
    const gaps = state.lastGaps;
    // ...
    summary += "[MAJOR] color_temperature, atmosphere\n";
    summary += "[MODERATE] brightness\n";
    summary += "[MINOR] light_direction, ...\n";
    // 没有方向信息、没有量化数字
}
```

LLM 看到的：

```
[MAJOR] color_temperature, atmosphere
[MODERATE] brightness
[MINOR] light_direction, shadow_depth, contrast, saturation, color_cast
```

LLM 不知道 color_temperature 是太冷还是太暖、atmosphere 是太清还是太浊。它必须回到上轮 assess_lighting 的 JSON 里查——而 JSON 可能在上下文前半段，已经被压缩或丢失。

### 3.2 改造方案

`buildGapSummary` 输出按 Tier 分组的维度明细表，每条包含 gap 评级、方向描述、量化数字:

```
当前 Gap 状态:

Tier 1 — CORE_LIGHTING (先解决):
  light_direction     [MINOR]  高角，缺少低角度光的方向感
  color_temperature   [MAJOR]  too_cool — 场景偏冷白，参考图为暖金
                                R/B比: ref 1.42 → cur 0.95 (差 -0.47)
  brightness          [MODERATE] too_bright — 场景整体偏亮
                                亮度: ref 98.5 → cur 132.7 (+34.7%)
  shadow_depth        [MINOR]  阴影柔软，接近参考

Tier 2 — ATMOSPHERE (Tier 1 完成后才能调):
  atmosphere          [MAJOR]  too_clear — 场景远景清晰，参考图有明显雾气衰减

Tier 3 — POSTPROCESS (Tier 1-2 完成后才能调):
  contrast            [MINOR]  close_enough
  color_cast          [MINOR]  close_enough
  saturation          [MINOR]  less_saturated — 饱和度偏低
                               饱和度: ref 78.3 → cur 65.1 (-13.1%)

直方图相关性: 0.42 (低 — 画面整体色调分布差异大，检查是否存在结构性不匹配)

阻塞维度: light_direction (太阳高度角差异 — 必须先解决，否则其他维度调整无效)

assess_lighting: 3/15  |  check_dimension: 5/20
```

### 3.3 数据来源

当前 `state.lastGaps` 的类型是 `Record<string, "minor"|"moderate"|"major">`，只存了维度名→评级。需要扩展 `PhaseState`:

```typescript
// phase-machine.ts — 替换 lastGaps
interface GapEntry {
    dimension: string;
    tier: number;
    gap: "minor" | "moderate" | "major";
    direction: string;
    ratingDiff: number;
    quantitative: {
        refValue: number;
        curValue: number;
        delta: string;
    } | null;
    qualitative: string | null;
}

interface PhaseState {
    // ...现有字段保留...
    lastGapEntries: GapEntry[];  // 替换 lastGaps
    lastHistogramCorrelation: number;
    blockingDimensions: string[];
}
```

### 3.4 改动点

| 文件 | 改动 | 行数 |
|------|------|:--:|
| `phase-machine.ts` | 新增 `GapEntry` 接口；`PhaseState` 用 `lastGapEntries` 替换 `lastGaps`；`onAssessLighting` 存储完整 gap 条目 | ~25 |
| `injections.ts` | `buildGapSummary` 重写为按 Tier 分组的明细表；新增 `buildBlockerSummary` | ~40 |
| `assess-lighting.ts` | `executeAssessLighting` 传完整 gaps 给 `onAssessLighting`（目前已经传了，不需要改） | 0 |

---

## 4. 改造三: 阻塞维度

### 4.1 概念

**阻塞维度**（blocking dimension）是一个前置依赖概念——某些维度不改，其他维度的调整是徒劳的。

判断逻辑**不是**来自 gap 评级的绝对值，而是来自维度的方向描述和场景几何：

```
light_direction:
  当前: rating=3, desc="高角度光，太阳近天顶"
  参考: rating=4, desc="低角度光，光源在画面右上方"
  diff=1 → gap=minor (评级低)  ← 但这不是 minor!
  
  因为: 太阳高度角决定了:
    - 雾的散射颜色在画面中的分布
    - 大气散射的暖色调方向
    - 云层被照亮的面积和颜色
    - 地面阴影的长度和方向
  不改 light_direction 调雾/云/大气参数 = 调整参数但视觉效果不变
```

### 4.2 判定规则

在 `executeAssessLighting` 的 gap 计算之后追加一个 `findBlockers()`:

```
findBlockers(gaps, quantitative):

  初始化: blockers = []

  规则 1 — light_direction 结构性检查:
    如果 light_direction.gap != "minor" 
    且 quantitative.histogramCorrelation < 0.5:
      → 追加 "light_direction (太阳角度差异 — 必须先解决，否则其他维度调整无效)"

  规则 2 — color_temperature 为 major:
    color_temperature.gap == "major" 
    且 direction == "too_cool" 或 "too_warm":
      → 追加 "color_temperature (全局色温偏差大 — 影响所有大气和雾的颜色)"

  规则 3 — artificiality 检测:
    artificiality.detected == true:
      → 追加 "post_processing (检测到人工滤镜感 — 回退 PostProcess 后重新评估)"

  返回 blockers
```

### 4.3 在哪些地方生效

**assess_lighting 输出**: 顶层新增 `blocking_dimensions` 字段，LLM 在 JSON 中可直接看到。

**before_agent_start 注入**: `buildBlockerSummary` 在 gap 摘要末尾追加阻塞维度信息。

**guard-rules**: Tier 门控检查阻塞维度：

```
如果 LLM 想调 Tier 2 参数:
  检查 state.blockingDimensions 是否非空:
    如果非空 → block
    原因: "Tier 1 存在阻塞维度: light_direction。必须先解决阻塞维度才能进入 Tier 2。"
```

### 4.4 改动点

| 文件 | 改动 | 行数 |
|------|------|:--:|
| `assess-lighting.ts` | 新增 `findBlockers()` 函数；`AssessLightingResult` 加 `blocking_dimensions` | ~30 |
| `phase-machine.ts` | `onAssessLighting` 存储 `blockingDimensions` 到 `PhaseState` | ~5 |
| `guard-rules.ts` | Tier 门控新增阻塞维度检查 | ~10 |
| `injections.ts` | 新增 `buildBlockerSummary` | ~15 |

---

## 5. 改造四: check_dimension 连续 further 的三阶段响应

### 5.1 现状

```typescript
// phase-machine.ts:113-115
export function onCheckDimension(state: PhaseState): void {
    state.checkCount++;
}
```

只计数，不管 verdict。连续 further 只能靠 `checkLimits` 的总次数上限（20 次）捕获，太晚了。

### 5.2 改造方案

**PhaseState 新增字段:**

```typescript
interface PhaseState {
    // 新增
    lastCheckDimension: string | null;
    consecutiveSameDimensionFurther: number;
}
```

**三阶段响应（均在 `before_agent_start` 注入中实现，不侵入工具代码）:**

```
阶段 1 — 第 1 次 further:
  不拦截工具调用。
  注入提示:
    "注意: check_dimension 返回 further (维度: color_temperature)。
     当前方向可能反了，请尝试反向调整或检查是否受阻塞维度 light_direction 的影响。"

阶段 2 — 第 2 次 further (同一维度):
  拦截工具调用 (guard-rules)。
  原因:
    "color_temperature 连续 2 次 further。可能原因:
       1. 调整方向持续错误 — 请尝试反向调整
       2. 受阻塞维度 light_direction 影响 — 请先解决阻塞维度
       3. 调整量太小 — 请增大参数变化幅度 (如 intensity 从 10 改到 30)
     操作: 回退此维度的改动，然后选择上述任一排查方向。"

阶段 3 — 第 3 次 further (同一维度):
  硬拦截 + 提示:
    "color_temperature 连续 3 次 further。已达到当前场景的物理极限或前置条件不满足。
     操作:
       a. 回退此维度的所有改动
       b. 调 assess_lighting 重新评估全局状态
       c. 如果所有可调参数都已尝试，向用户报告最终状态和无法匹配的原因"
```

**verdict 为 "closer" 或 "similar" 时重置计数:**

```typescript
export function onCheckDimension(state: PhaseState, dimension: string, verdict: string): void {
    state.checkCount++;

    if (verdict === "further") {
        state.consecutiveSameDimensionFurther = 
            (state.lastCheckDimension === dimension) 
                ? state.consecutiveSameDimensionFurther + 1 
                : 1;
    } else {
        state.consecutiveSameDimensionFurther = 0;  // closer/similar 时重置
    }
    state.lastCheckDimension = dimension;
}
```

### 5.3 改动点

| 文件 | 改动 | 行数 |
|------|------|:--:|
| `phase-machine.ts` | `PhaseState` 加 2 字段；`onCheckDimension` 改为接收 verdict 和 dimension；`checkLimits` 加 further 硬上限 | ~20 |
| `index.ts` | `tool_result` handler 中 `onCheckDimension` 调用传参（从 `check_dimension` 返回的 JSON 中取 verdict） | ~5 |
| `guard-rules.ts` | 新增 further 阶段 2 的拦截规则 | ~10 |
| `injections.ts` | `TUNING` 模板根据 `consecutiveSameDimensionFurther` 动态追加引导 | ~15 |

---

## 6. 影响范围总览

| 文件 | 改动性质 | 估计行数 |
|------|------|:--:|
| `assess-lighting.ts` | 量化校验 + blocking_dimensions | +50 |
| `phase-machine.ts` | PhaseState 扩展 + further 计数 | +45 |
| `injections.ts` | gap 摘要重写 + blocker 摘要 + further 引导 | +55 |
| `guard-rules.ts` | Tier 门控加 blocker 检查 + further 阶段2 拦截 | +20 |
| `index.ts` | tool_result handler 传 verdict 给 phase-machine | +5 |
| **总计** | | **~175** |

不改: `metrics.ts`, `capture.ts`, `vision-client.ts`, `prompts.ts`（量化计算和 Vision 调用本身工作正常）。

---

## 7. 验证标准

| # | 验证项 | 预期 |
|:--:|------|------|
| 1 | `assess_lighting` 返回包含 `blocking_dimensions` | 太阳高角场景 → `["light_direction"]` |
| 2 | 量化校验生效 | Vision 说 minor 但 delta >30% → 改判 moderate 或 major |
| 3 | `buildGapSummary` 输出按 Tier 分组的明细表 | 纯文本、含方向描述、含量化数字（如有）、无 emoji |
| 4 | 阻塞维度塞入 `before_agent_start` | LLM 每轮都能看到阻塞维度列表 |
| 5 | Tier 2 工具调用被 blocker 拦截 | LLM 试图调雾参数 → block: "阻塞维度 light_direction 未解决" |
| 6 | check_dimension 第 1 次 further → 提示 | 注入方向错误提示 |
| 7 | check_dimension 第 2 次 further → 拦截 | block + 三选一排查指引 |
| 8 | check_dimension 第 3 次 further → 硬停 | block + 要求回退并 reassess |
| 9 | 直方图相关性 < 0.3 → 追加 pseudo-gap | overall_composition [MAJOR] |
| 10 | closer/similar 后 further 计数重置 | 调对方向后，further 计数从零重新开始 |

---

## 8. 不做的事项

1. **属性名自动发现/映射**: UE 工具暴露的 PascalCase 属性名（`fogInscatteringLuminance`, `bAtmosphereSunLight`）与直观名称不一致的问题——这是 UE 侧的问题，不在本次 PRD 范围。white-list 映射（atmosphere-whitelist.ts）已存在，后续可扩展。
2. **Vision 模型可见性**: Pi 主模型能否看到参考图取决于用户配置的模型能力，不在扩展代码控制范围内。
3. **自动回退机制**: check_dimension further 后的回退操作仍由 LLM 执行（根据注入的引导），扩展只拦截和提示，不自动改参数。
