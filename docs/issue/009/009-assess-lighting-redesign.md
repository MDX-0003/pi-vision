# Issue 009 — assess_lighting 串行化 + 定量指标扩容 + Vision 角色重定义

**状态**: 待实施
**依赖**: Issue 007（assess_lighting 现有实现）、Issue 008a-008e（预设系统）
**PRD**: 本文件
**最后修订**: 2026-08-11（v3 — Prompt 根因判定 + PostProcess 默认值重置）

---

## 1. 动机

当前 assess_lighting 存在三个结构性缺陷（见 LLM 反馈）：

| 问题 | 根因 | 影响 |
|------|------|------|
| Quantitative 与 Vision 并行竞争 | `computeGap()` 取 max(定量, Vision)，定量被 auto-exposure 污染后永远报 major | LLM 亮度调到死也过不了 Tier 1 |
| 人工感检测造成 catch-22 | PostProcess 被检测到 → 要求回退 → guard 拦截 Tier 1 阶段动 Tier 3 参数 | LLM 只能绕过前端调脚本 |
| check_dimension 冗余 | LLM 几乎不调它，每次都调 assess_lighting | 功能性代码白白占用 Vision token |

**核心重构方向**：Vision 从"并行竞争者"变为"串行决策者"。定量指标先计算 → 注入 Vision prompt 作为参考数据 → Vision 综合判断给出一份分析。不再有代码层的"定量 vs Vision 调和"。

---

## 2. 架构对比

### 2.1 当前架构（Issue 007）

```
assess_lighting:
  Promise.all([                                  ← 5 个并行 Vision 调用
    computeMetrics(ref, cur),                      // 定量
    Vision(ref, atmosphere),                       // 参考图氛围
    Vision(cur, atmosphere),                       // 当前截图氛围
    Vision(cur, artificiality),                    // 人工感检测
    Vision(ref, tagging),                          // 标签（008c 新增）
  ])
  → computeGap(取 max 定量 vs Vision 评级差)
  → computeDirection()
  → findBlockers()
  → 返回 { atmosphere, gaps, quantitative, artificiality, blocking_dimensions }

check_dimension:
  Vision(cur + dimension + refRating) → closer/similar/further + rating
```

### 2.2 新架构（Issue 009）

```
assess_lighting:
  Stage 1 (并行, <20ms):
    computeMetrics(ref, cur)     // 定量
    analyzeAndTag(ref)           // 标签（已由 008c 引入）
                                   ← 两者无依赖，并行

  Stage 2 (串行, 1 次 Vision):
    Vision(参考图 + 截图 + quantitativeReport)
    → { analysis: [...], overall: "..." }
                                   ← Vision 直接看数字+图，不需要代码调和

check_dimension:
  删除。
```

**一次 assess = 1 次 Vision atmosphere 调用 + 1 次 Vision 标签调用（并行）。从 5 次降到 2 次。check_dimension 不再存在。**

---

## 3. 定量指标扩容

### 3.1 指标清单

| 指标 | 来源参考 | 测量什么 | 为何有用 |
|------|------|------|------|
| `luminance` | 已有 | 感知亮度均值 (0.299R+0.587G+0.114B) | 基本亮度 |
| `colorTempRatio` | 已有 | 全局 R/B 比 | 基本色温 |
| `saturation` | 已有 | HSV S 均值 | 基本饱和度 |
| `histogramCorrelation` | 已有 | 64x64 灰度 Pearson | 整体色调分布 |
| **`perChannel`** | compare_images.py §1 | R/G/B 各通道 mean/std | 单通道偏色检测 |
| **`tonalRB`** | compare_atmosphere.py §1 | Shadow/Midtone/Highlight 分调性 R/B 比 + directionFlipped | LLM 反馈的 brightness 被 auto-exposure 污染——分调性数据可直接诊断 |
| **`deltaE`** | compare_images.py §6 | CIEDE76 感知色差 (mean/median/p90 + 分区域) | 最接近"人眼觉得像不像"的数值 |
| **`chroma`** | compare_atmosphere.py §3 | CIELAB sqrt(a*²+b*²) 均值 | 色彩强度，独立于亮度——不受 auto-exposure 干扰 |
| **`hueJSD`** | validate_metrics.py | 12-bin 色相直方图 Jensen-Shannon 散度 | 全局偏色 |
| **`regional`** | compare_images.py §3 | 天空/地平线/地面分别的亮度、R/B、饱和度 | 天空亮度主导全局均值——分区域排除天空干扰 |
| **`gradientCorrelation`** | compare_images.py §4 | 纵向亮度梯度的 Pearson 相关性 | 光源方向的一致性 |
| **`zoneBalance`** | test_structural_metrics.py §E | 11 区曝光 Zone System 直方图形状相关性 | 纯结构对比，不受绝对亮度偏移影响 |

### 3.2 分调性 R/B 的特殊价值

这是针对此次 LLM 反馈直接有效的指标。当前：

```
全局 brightness delta +38% → major → 卡住 LLM
```

新的 `tonalRB` 能揭露：

```
Shadow R/B: 1.18→1.21 (Δ+0.03) ← 暗部色温接近参考，DirectionalLight 调参有效
Highlight R/B: 1.35→1.33 (Δ-0.02) ← 高光色温接近参考
天空 brightness: +22% ← 全局 +38% 的真正来源
地面 brightness: +10% ← 地面接近参考
```

Vision 看到这些数据后，能区分"DirectionalLight 调参已到位" vs "天空主导全局偏差" → 不会要求 LLM 继续死磕 brightness → 给出正确的 tier 推进建议。

### 3.3 Delta E 的验收价值

Delta E 是 CIELAB 色彩空间中的欧几里德距离。公认：
- ΔE < 1: 肉眼不可分辨
- ΔE 1-3: 仅训练过的观察者能分辨
- ΔE 3-6: 普通观察者可分辨
- ΔE > 6: 明显可见的色差

此数值给 Vision 一个客观的"够不够像"参考线：如果 Delta E mean < 3 且 Vision 肉眼觉得 close_enough，系统应不再要求继续调参。

---

## 4. 新的 assess_lighting Prompt

### 4.1 完整 Prompt

```
你是一个 UE5 光照分析助手。

你会收到 2 张图片:
  - 第 1 张: 参考图 (目标效果)
  - 第 2 张: 当前 UE 视口截图

此外，你还会收到一份自动计算的定量像素对比数据 (quantitative_report)。

## 你的任务是:

列出当前画面与参考图之间存在的**明显、肉眼可见、可通过调 UE5 参数改善**的差异。
对每一项差异给出结构化判断。

## quantitative_report

以下数据由代码自动计算 (不需要你复述):
(整段 JSON 由代码原地替换，包含 luminance / perChannel / tonalRB / deltaE / chroma / hueJSD / regional / gradientCorrelation / zoneBalance / histogramCorrelation)

## 输出格式

每个差异项目必须包含:
  - aspect: 差异的简短名称 (英文 kebab-case, 如 "brightness", "shadow_warmth")
  - status: "close_enough" 或 "needs_adjustment"
  - tier: 1 / 2 / 3
  - suggestion: 1-2 句中文诊断 + 具体调参建议

同时输出 overall: 1-2 句中文总结当前总体状态

返回纯 JSON (无 markdown 代码块):

{
  "analysis": [...],
  "overall": "..."
}

## 重要准则

1. close_enough != 完全一致。这一点至关重要。
   只有当差异**清晰可见**且**可以通过调整 UE5 参数明显缩小**时，才标记 needs_adjustment。
   轻微差异、不确定的差异、由画面内容不同导致的差异(参考图有特殊物体、几何结构不同等)
   --都应标记为 close_enough。
   参考图和 UE 截图不可能像素级一致，追求完全一致会陷入无限调参。见好就收。

2. 如果 quantitative_report 的某个数字与你肉眼观察有矛盾:
   **以你的肉眼观察为准**，不要盲目信任数字。
   在 suggestion 中解释为什么数字不准。
   例如: "brightness 定量显示 +38.9% 由天空主导，实际 DirectionalLight 照亮的区域已接近参考--此偏差来自 auto-exposure，不应继续压暗主光"

3. tier 字段与根因判定:

   每个 tier 对应一组可调参数:
   - Tier 1: DirectionalLight, SkyLight (lightColor, intensity, temperature, lightSourceAngle)
   - Tier 2: SkyAtmosphere, ExponentialHeightFog, VolumetricCloud (散射、密度、高度等)
   - Tier 3: PostProcessVolume (whiteTemp, colorSaturation, colorContrast, colorGamma, autoExposureBias 等)

   __CURRENT_TIER_INFO__

   每个 aspect 的 tier 字段应填**根因所属的 tier** -- 即哪个 tier 的参数调整能真正解决此差异。
   **关键判断**: 如果根因属于当前 tier 之上的 tier (当前 tier 的参数无法解决此差异)，
   标记 status: "close_enough"，在 suggestion 中说明建议在哪个 Tier 处理。
   如果根因就是当前 tier 的参数问题，标记 status: "needs_adjustment"。

   示例: brightness +38%，但 tonalRB 显示 Shadow R/B 仅偏离 0.03，regional 显示天空主导全局偏差。
   -> 根因是 auto-exposure (Tier 3)，DirectionalLight (Tier 1) 已到位。
   -> tier: 3, status: "close_enough", suggestion: "DirectionalLight色温已达标，全局亮度偏差来自天空+auto-exposure，建议Tier 3处理"

   调参必须按 Tier 顺序 (1->2->3)。如果 Tier 1 仍有 needs_adjustment，
   Tier 2/3 的 aspect 也可以列出，但在 suggestion 中注明"建议在 Tier 1 完成后处理"。

4. 如果某个 quantitative 差异数值很大, 但你判断**不需要继续调参**:
   仍然在 analysis 中列出此 aspect, 标记 close_enough,
   在 suggestion 中解释"为什么不建议继续调"。

5. 不要输出超过 6 个 analysis 条目。合并微小的同类差异。

6. 只比较光照氛围--光的方向、色温、亮度、饱和度、大气雾感、对比度、阴影深浅。
   不要比较画面中的具体物体、几何结构、纹理。

7. 如果 quantitative_report 中的 tonalRB.directionFlipped 为 true
   (Shadow 和 Highlight 的色温偏移方向相反), 这通常意味着 PostProcessVolume 存在人工后期调色。
   请勿输出单独的 "post_processing" aspect--而是分析哪些氛围维度的表现受后处理影响,
   并在对应 aspect 的 suggestion 中注明。

8. 如果 quantitative_report 中的 deltaE.mean < 3:
   这表明两图的感知色差已在肉眼难以分辨的范围内。
   对于数值差距最大的 aspect，如果没有明显的视觉差异，应标记 close_enough。
```

### 4.2 Prompt 生成方式

`prompts.ts` 中 `ASSESS_LIGHTING_PROMPT` 是静态模板，含两个占位符：

| 占位符 | 替换内容 | 替换时机 |
|------|------|------|
| `__QUANTITATIVE_REPORT__` | `JSON.stringify(quantitative)` | `executeAssessLighting` |
| `__CURRENT_TIER_INFO__` | 当前 tier 编号 + 该 tier 可调参数列表 + 调参阶段说明 | `executeAssessLighting` |

`__CURRENT_TIER_INFO__` 的生成逻辑：

```typescript
function buildCurrentTierInfo(tier: number, tierRoundCount: number): string {
  const paramMap: Record<number, string> = {
    1: "当前调参阶段: Tier 1 (第 " + tierRoundCount + " 轮)\n" +
       "可调参数: DirectionalLight.lightColor/intensity/temperature/lightSourceAngle, SkyLight.lightColor/intensity\n" +
       "不可调: SkyAtmosphere, ExponentialHeightFog, VolumetricCloud, PostProcessVolume (这些属于更高 Tier)",
    2: "当前调参阶段: Tier 2 (第 " + tierRoundCount + " 轮)\n" +
       "可调参数: SkyAtmosphere, ExponentialHeightFog, VolumetricCloud (散射、密度、高度等)\n" +
       "不可调: PostProcessVolume (属于 Tier 3)",
    3: "当前调参阶段: Tier 3 (第 " + tierRoundCount + " 轮)\n" +
       "可调参数: PostProcessVolume (whiteTemp, colorSaturation, colorContrast, colorGamma, autoExposureBias 等)",
  };
  return paramMap[tier] ?? paramMap[1];
}
```

`TAG_DESCRIPTIONS` 和 `buildTaggingPrompt()` 保留不动。

---

## 5. 新的输出结构

```typescript
// tools/assess-lighting.ts

interface AnalysisEntry {
  /** Vision 命名的差异名称 (kebab-case, 如 "brightness", "shadow_warmth") */
  aspect: string;
  /** 此差异是否需要继续调参 */
  status: "close_enough" | "needs_adjustment";
  /** 关联的 Tier (1/2/3), 由 Vision 在 prompt 指令下标记 */
  tier: number;
  /** 诊断 + 具体调参建议 (1-2 句中文) */
  suggestion: string;
}

interface AssessLightingResult {
  success: boolean;
  error?: string;

  reference: { path: string; fileSize: number };
  current: { filePath: string; fileSize: number };

  /** 代码计算的完整定量报告 */
  quantitative: QuantitativeReport;

  /** Vision 的结构化分析 */
  analysis: AnalysisEntry[];

  /** Vision 的总体评价 (1-2 句) */
  overall: string;

  /** Issue 008c: 参考图的标签 (与 metrics 并行计算) */
  tagResult?: TagResult;

  meta: {
    visionTokens: number;
    captureMs: number;
    quantitativeMs: number;
    visionMs: number;
  };
}
```

### 5.1 删除的字段

| 旧字段 | 删除原因 |
|------|------|
| `gaps: DimensionGap[]` | 不再由代码判定 gap——Vision 直接输出 analysis |
| `quantitative.luminanceDelta / colorTempRatioDelta / saturationDelta` | 从 analysis 中按需查看 `quantitative` 完整数据 |
| `reference.atmosphere` | 不再单独分析参考图 |
| `current.atmosphere` | 不再单独分析截图 |
| `artificiality` | 概念删除——Vision 在对应 aspect 的 suggestion 中指出后处理问题 |
| `blocking_dimensions` | 替换为 analysis 中 status=needs_adjustment 的 aspect |

---

## 6. 流水线实现

```typescript
// tools/assess-lighting.ts — executeAssessLighting()

export async function executeAssessLighting(params: { reference_path: string }): Promise<AgentToolResult> {
  const ueClient = getUeClient();
  const vision = getVisionClient();

  // 加载参考图
  const refBuffer = readFileSync(params.reference_path);
  const refBase64 = refBuffer.toString("base64");

  // 截图
  const capture = await captureViewport(ueClient, 1.0);

  // ═══════════════════════════════════
  // Stage 1 (并行): 定量 + 标签
  // ═══════════════════════════════════
  const qStart = Date.now();
  const [quantitative, refTagResult] = await Promise.all([
    computeMetrics(refBuffer, Buffer.from(capture.base64, "base64")),
    analyzeAndTag(vision, refBase64),
  ]);
  const quantitativeMs = Date.now() - qStart;

  // ═══════════════════════════════════
  // Stage 2 (串行): Vision 氛围分析
  // ═══════════════════════════════════
  const vStart = Date.now();
  const quantReportStr = JSON.stringify(quantitative);
  const tierInfo = buildCurrentTierInfo(state.tier, state.tierRoundCount);
  const prompt = ASSESS_LIGHTING_PROMPT
    .replace("__QUANTITATIVE_REPORT__", quantReportStr)
    .replace("__CURRENT_TIER_INFO__", tierInfo);

  const visionRaw = await vision.sendAndParse<{
    analysis: AnalysisEntry[];
    overall: string;
  }>({
    prompt,
    images: [
      { base64: refBase64 },
      { base64: capture.base64 },
    ],
    maxTokens: 3000,
  });
  const visionMs = Date.now() - vStart;

  // 组装
  const result: AssessLightingResult = {
    success: true,
    reference: { path: params.reference_path, fileSize: refBuffer.length },
    current: { filePath: capture.filePath, fileSize: capture.fileSize },
    quantitative,
    analysis: visionRaw.analysis,
    overall: visionRaw.overall,
    tagResult: refTagResult,
    meta: {
      visionTokens: 1 * 3000,  // 1 Vision call (atmosphere) + 1 tag call (separate)
      captureMs: capture.elapsedMs,
      quantitativeMs,
      visionMs,
    },
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
```

---

## 7. Phase 状态机适配

### 7.1 PhaseState 变更

```typescript
interface PhaseState {
  phase: Phase;
  tier: number;
  assessCount: number;
  lastAnalysis: AnalysisEntry[];          // 替换 lastGapEntries
  lastOverall: string;                     // 新增
  lastHistogramCorrelation: number;
  artificialityDetected: boolean;          // 保留但不再由代码判定——Vision 在 analysis 中体现
  blockingAspects: string[];               // 替换 blockingDimensions (aspect 名列表)

  // --- Issue 009 新增: tier 轮数追踪 ---
  /** 当前 tier 内 assess_lighting 调用次数 (tier 升级时归零) */
  tierRoundCount: number;
  /** 本 tier 内 close_enough 数量最多的一轮 (用于收尾提示) */
  bestRound: {
    assessIndex: number;         // 全局 assessCount
    closeEnoughCount: number;
    needsAdjustmentCount: number;
    overall: string;
  } | null;

  // Issue 008c 保留
  lastTagResult?: TagResult;

  // --- 移除的字段 ---
  // - checkCount
  // - lastCheckDimension
  // - consecutiveSameDimensionFurther
  // - lastQuantitative
  // - quantitativeHistory       // 替换为 quantitativeSnapshots (见 §8.2)
  // - lastGapEntries
  // - blockingDimensions
  // - unchangedRounds           // 替换为 tierRoundCount + bestRound
}
```

### 7.2 Tier 升级逻辑

```typescript
/** 每个 tier 最多进行 10 轮调参。超过后不强制推进，通过注入提示 LLM 做选择。 */
const TIER_MAX_ROUNDS = 10;

/** 当前 tier 所有 aspect 是否都已 close_enough */
function allTierAspectsClosed(analysis: AnalysisEntry[], tier: number): boolean {
  const tierAspects = analysis.filter(a => a.tier === tier);
  if (tierAspects.length === 0) return true;
  return tierAspects.every(a => a.status === "close_enough");
}

/** 追踪本 tier 内 close_enough 最多的一轮，用于收尾提示 */
function trackBestRound(state: PhaseState, analysis: AnalysisEntry[], overall: string): void {
  const ce = analysis.filter(a => a.status === "close_enough").length;
  const na = analysis.filter(a => a.status === "needs_adjustment").length;

  if (
    !state.bestRound ||
    ce > state.bestRound.closeEnoughCount ||
    (ce === state.bestRound.closeEnoughCount && na < state.bestRound.needsAdjustmentCount)
  ) {
    state.bestRound = {
      assessIndex: state.assessCount,
      closeEnoughCount: ce,
      needsAdjustmentCount: na,
      overall,
    };
  }
}

/** 推进到下一个 tier，重置轮数计数器 */
function advanceTier(state: PhaseState): void {
  if (state.tier === 1) {
    state.tier = 2;
    state.tierRoundCount = 0;
    state.bestRound = null;
  } else if (state.tier === 2) {
    state.phase = "POSTPROCESS_SETUP";
    state.tierRoundCount = 0;
    state.bestRound = null;
  } else if (state.tier === 3) {
    state.phase = "FINAL";
    state.tierRoundCount = 0;
    state.bestRound = null;
  }
}

export function onAssessLighting(analysis: AnalysisEntry[], overall: string): PhaseState {
  state.assessCount++;
  state.tierRoundCount++;
  state.lastAnalysis = analysis;
  state.lastOverall = overall;

  // 追踪本 tier 最佳轮
  trackBestRound(state, analysis, overall);

  // blocking aspects: 所有 status=needs_adjustment 的 aspect
  state.blockingAspects = analysis
    .filter(a => a.status === "needs_adjustment")
    .map(a => a.aspect);

  // Phase 转换逻辑
  switch (state.phase) {
    case "SETUP":
      state.phase = "TUNING";
      state.tier = 1;
      state.tierRoundCount = 0;
      state.bestRound = null;
      break;

    case "TUNING":
      // 正常路径: Vision 判定当前 tier 全部 close_enough → 自动升级
      if (allTierAspectsClosed(analysis, state.tier)) {
        advanceTier(state);
      }
      // tierRoundCount >= TIER_MAX_ROUNDS 时不强制推进。
      // 由 before_agent_start 注入收尾提示，LLM 自行决定是否继续调参。
      // 如果 LLM 停止调参并开始关注下一 tier 的参数，下一轮 assess 时
      // Vision 可能将剩余 aspect 标记为 close_enough，从而触发正常升级。
      break;

    case "POSTPROCESS_SETUP":
      state.phase = "TUNING";
      state.tier = 3;
      state.tierRoundCount = 0;
      state.bestRound = null;
      break;

    case "FINAL":
      // 宽松判定: 不再有 needs_adjustment → DONE
      if (analysis.every(a => a.status === "close_enough")) {
        state.phase = "DONE";
      }
      break;
  }
  return state;
}
```

### 7.3 移除的函数

| 函数 | 原因 |
|------|------|
| `allTierDimsMinor()` | 替换为 `allTierAspectsClosed()` |
| `computeUnchangedRounds()` | 替换为 `tierRoundCount` + `bestRound` 追踪 |
| `storeQuantitative()` | quantitative 完整存储在 assess_lighting 返回中；跨轮趋势由 §8.2 的 `quantitativeSnapshots` 处理 |
| `getDimensionTrends()` | 维度概念移除；趋势信息由 `buildQuantitativeTrendSummary()` 提供（见 §8.2） |
| `isTierOneSettled()` | 替换为 `allTierAspectsClosed(analysis, 1)` + tier 收尾提示 |
| `onCheckDimension()` | check_dimension 删除 |
| `getFurtherStage()` | check_dimension 删除 |
| `checkLimits()` 中 check/further 相关限制 | check_dimension 删除 |

### 7.4 保留的硬上限

```typescript
const MAX_ASSESS = 30;  // 全局 assess_lighting 调用上限 (3 tiers × 10 rounds)

export function checkLimits(state: PhaseState): LimitCheck {
  if (state.assessCount >= MAX_ASSESS) {
    return {
      shouldStop: true,
      reason: `assess_lighting 调用次数已达上限 (${MAX_ASSESS})`,
    };
  }
  return { shouldStop: false };
}
```

### 7.5 SETUP 阶段 PostProcess 默认值重置

**问题**: 场景中可能存在非默认的 PostProcess 设置（来自上一次会话残留或其他工具修改）。这会导致两个问题：
- Vision 看到的色温/饱和度偏差可能来自 PostProcess 滤镜而非光源，造成根因 tier 误判
- `tonalRB.directionFlipped` 可能因 PostProcess 色偏而误报

**方案**: 在首次 `assess_lighting` 时（`state.phase === "SETUP"`），由扩展**直接调用** UE MCP 将 PostProcess color grading 参数重置为引擎默认值。不通过 LLM 工具调用，不受 guard-rules 拦截。后续 Tier 3 阶段的 PostProcess 调参是正常的微调行为，不再需要 artificiality 拦截。

**重置的参数清单**（UE5 PostProcessVolume 默认值）：

| 参数 | 默认值 | 说明 |
|------|------|------|
| WhiteTemp | 6500 | 白平衡色温 |
| ColorSaturation (R/G/B/A) | (1,1,1,1) | 色彩饱和度 |
| ColorContrast (R/G/B/A) | (1,1,1,1) | 色彩对比度 |
| ColorGamma (R/G/B/A) | (1,1,1,1) | 色彩伽马 |
| FilmSlope | 0.88 | 胶片斜率 |
| FilmToe | 0.55 | 胶片趾部 |
| SceneFringeIntensity | 0 | 色散强度 |
| ColorGradingIntensity | 1 | 调色混合权重 |

**实现**（`tools/assess-lighting.ts`）：

```typescript
// PPV 的 color grading 参数嵌套在 Settings 子结构 (FPostProcessSettings) 中。
// 必须: get_properties 读取 settings → 修改 + bOverride 标志 → values JSON 字符串写回。
// 参考: E:/Programs/UE_Project_58/MCP/Test/ppv_test2.py, test_ppv_direct.py
async function resetPostProcessToDefaults(ueClient: UeClient): Promise<void> {
  const GET = "toolset_registry.toolsets.core.object.ObjectTools.get_properties";
  const SET = "toolset_registry.toolsets.core.object.ObjectTools.set_properties";
  const FIND = "toolset_registry.toolsets.core.scene.SceneTools.find_actors";

  // Step 1: 查找所有 PostProcessVolume actor
  const findResult = await ueClient.callTool(FIND, { glob: "*PostProcessVolume*", tag: "" });
  const parsed = parseUeReturnValue(findResult.text);
  const refPaths = extractActorRefPaths(parsed);
  if (!refPaths?.length) return;

  for (const refPath of refPaths) {
    // Step 2: 读取完整 settings struct
    const getResult = await ueClient.callTool(GET, {
      instance: { refPath }, properties: ["settings"],
    });
    let raw = parseUeReturnValue(getResult.text);
    if (typeof raw === "string") raw = JSON.parse(raw);
    const settings = (raw as any)?.settings;
    if (!settings) continue;

    // Step 3: 修改 + bOverride 标志
    const s = { ...settings };
    s.bOverride_WhiteTemp = true;           s.WhiteTemp = 6500;
    s.bOverride_ColorSaturation = true;     s.ColorSaturation = { X:1,Y:1,Z:1,W:1 };
    s.bOverride_ColorContrast = true;       s.ColorContrast = { X:1,Y:1,Z:1,W:1 };
    s.bOverride_ColorGamma = true;          s.ColorGamma = { X:1,Y:1,Z:1,W:1 };
    s.bOverride_FilmSlope = true;           s.FilmSlope = 0.88;
    s.bOverride_FilmToe = true;             s.FilmToe = 0.55;
    s.bOverride_SceneFringeIntensity = true; s.SceneFringeIntensity = 0;
    s.bOverride_ColorGradingIntensity = true; s.ColorGradingIntensity = 1;

    // Step 4: values JSON 字符串写回 (非 properties object!)
    await ueClient.callTool(SET, {
      instance: { refPath },
      values: JSON.stringify({ settings: s }),
    });
  }
}
```

**关键差异 vs 常规组件 (DirectionalLight/SkyLight) 的 set_properties**:
- PPV 使用 `values` (JSON 字符串)，常规组件使用 `properties` (object)
- PPV 需要先 `get_properties` 读取 settings → 修改 → 整体写回 struct
- PPV 需要设置 `bOverride_*` 标志，否则 UE 忽略该参数值

**guard-rules.ts 变更**:
- `artificialityDetected` 拦截逻辑（[guard-rules.ts:163-172](packages/ue-harness/src/workflow/guard-rules.ts#L163-L172)）移除——SETUP 阶段已完成重置，不再需要运行时检测
- PhaseState 中 `artificialityDetected` 字段移除

---

## 8. before_agent_start 注入适配

### 8.1 buildAnalysisSummary (替换 buildGapSummary)

每次 assess_lighting 返回后，`buildAnalysisSummary` 生成注入文本。格式遵循"克制"原则：不使用 emoji，仅在结构分层处使用标记符号。

```
## 当前分析状态

Tier 1 (第 4/10 轮):
  [needs_adjustment] brightness
    Shadow区域接近参考(R/B仅+0.03)，但全局亮度+38.9%由天空主导。
    -> 建议: 微降DirectionalLight intensity至0.08-0.10，进入Tier 3后调autoExposureBias

  [close_enough] color_temperature
    所有调性(Shadow/Midtone/Highlight)R/B比在+-0.05内，色温已达标

Tier 2:
  [needs_adjustment] atmosphere_haze
    Chroma偏低-3.1(Delta E horizon区域9.8)，天空雾感不足
    -> 建议: 增加MieScatteringScale至0.03-0.05

Vision 总评: Tier 1 仅brightness存在可见偏差(Shadow已达标，天空主导)，
建议进入Tier 2解决atmosphere后再回看是否需要Tier 3微调。

assess_lighting: 4/30
```

**收尾提示**（当 `tierRoundCount >= TIER_MAX_ROUNDS` 且当前 tier 未全部 close_enough 时追加）：

```
--
Tier 1 已进行 10 轮调参。
第 7 轮曾达到最佳状态 (3/4 aspects close_enough)。
如当前参数已接近该状态，建议接受现状，停止 Tier 1 调参并关注 Tier 2 的 atmosphere 问题。
```

收尾提示不强制推进 tier——代码层不做自动升级。LLM 看到提示后自行决定是否停止当前 tier 的调参。当 LLM 转而关注下一 tier 的参数时，下一轮 assess 中 Vision 可能将剩余 aspect 标记为 close_enough，从而触发 `allTierAspectsClosed` 的正常升级路径。

### 8.2 buildQuantitativeTrendSummary (新增)

`buildQuantitativeTrendSummary` 独立于 `buildAnalysisSummary`，维护最近 3 轮 assess 的定量快照，生成跨轮对比摘要。仅在 assessCount >= 3 时输出。

**数据存储**（PhaseState 新增字段）：

```typescript
/** 最近 3 轮定量快照 (newest last)，供跨轮趋势注入 */
quantitativeSnapshots: Array<{
  assessIndex: number;
  deltaE_mean: number;
  deltaE_p90: number;
  chroma_diff: number;
  skyLuminanceRatio: number;    // 天空亮度占全局亮度的比例
  groundLuminanceRatio: number; // 地面亮度占全局亮度的比例
  histogramCorrelation: number;
}>;
```

每轮 assess 后 push 当前快照，保留最近 3 个（超过时 shift 最旧的）。

**注入格式**：

```
## 定量趋势 (最近 3 轮)

| 指标 | #3 | #4 | #5 | 趋势 |
|------|-----|-----|-----|------|
| Delta E mean | 5.2 | 4.1 | 3.8 | 收敛 |
| Delta E p90 | 12.1 | 10.3 | 9.7 | 收敛 |
| Chroma diff | -3.1 | -2.8 | -2.9 | 停滞 |
| 天空亮度占比 | 38% | 35% | 36% | 天空仍主导 |
| 地面亮度占比 | 60% | 62% | 61% | 稳定 |
| 直方图相关 | 0.72 | 0.76 | 0.78 | 收敛 |

Delta E mean 降至 3.8 -- 感知阈值约 3，继续微调收益递减。
天空区域持续贡献 ~36% 全局亮度偏差 -- 全局 brightness 数值受天空主导，不应作为 DirectionalLight 调参唯一依据。
```

**趋势判定规则**（纯数值，不做语义解释）：

| 条件 | 趋势文本 |
|------|------|
| 最近值 / 最旧值 < 0.9 | "收敛" |
| 最近值 / 最旧值 > 1.1 | "扩大" |
| 连续 3 轮波动幅度 < 5% | "停滞" |
| 其他 | "波动" |

**Delta E 阈值提示规则**：

- Delta E mean < 3: 输出 "Delta E mean 降至 X.X -- 感知阈值约 3，继续微调收益递减。"
- Delta E mean 在 3-6 之间且趋势为"收敛": 输出 "Delta E mean X.X -- 仍在感知阈值之上但持续改善。"
- Delta E mean > 6: 不单独提示 Delta E，让 Vision 的 analysis 主导判断。

**天空亮度占比提示规则**：

- 天空占比 > 30% 且地面占比偏差 < 15%: 输出 "天空区域持续贡献 ~XX% 全局亮度偏差 -- 全局 brightness 数值受天空主导，不应作为 DirectionalLight 调参唯一依据。"

### 8.3 注入顺序

`before_agent_start` 注入的完整结构：

```
[预设匹配建议] (008c, 如有匹配)
[当前分析状态] (buildAnalysisSummary)
[定量趋势]     (buildQuantitativeTrendSummary, assessCount >= 3 时)
[收尾提示]     (tierRoundCount >= 10 且未全部 close_enough 时)
[unspecified 说明] (008c 保留)
```

### 8.4 unspecific 说明 (保持)

注入文本末尾保留 008c 预设匹配 + unspecified 说明。

---

## 9. 删除 check_dimension

### 9.1 删除文件

`tools/check-dimension.ts` — 完整删除

### 9.2 index.ts 变更

移除:
- `import { checkDimensionDef, executeCheckDimension } from "./tools/check-dimension.ts"`
- registerSelfTools() 中的 check_dimension 注册
- tool_result handler 中的 `else if (event.toolName === "check_dimension") {...}`

### 9.3 phase-machine.ts 变更

移除:
- `checkCount` 字段
- `lastCheckDimension` 字段
- `consecutiveSameDimensionFurther` 字段
- `onCheckDimension()` 函数
- `getFurtherStage()` 函数
- `checkLimits()` 中的 `MAX_CHECKS` / `MAX_FURTHER_HARD_STOP` 检查

---

## 10. 定量指标实现细节

### 10.1 关键算法 (纯 TypeScript, 不依赖 Python/numpy)

**tonalRB**: 感知亮度 `0.299R+0.587G+0.114B`，按 0-0.33/0.33-0.66/0.66-1.0 分三段，每段计算 `mean(R)/mean(B)`。

**deltaE (CIEDE76)**: `RGB→sRGB线性化→XYZ (D65)→CIELAB→sqrt((L1-L2)²+(a1-a2)²+(b1-b2)²)`

**chroma**: 与 deltaE 共享 CIELAB 中间结果: `sqrt(a²+b²)`

**hueJSD**: `HSV H → 12-bin histogram → normalize → JSD = 0.5*KL(P||M) + 0.5*KL(Q||M)`

**zoneBalance**: 亮度 → Zone(0-10) → histogram correlation

**regional**: 按像素行切三分，分别计算亮度/RB/饱和度

所有计算在 sharp 缩放到 1024px 后进行，与现有逻辑一致。

### 10.2 性能

- 当前 metrics 计算: ~8ms
- 扩容后: ~15-20ms (增加了 tonalRB ×3、deltaE ×1、chroma ×1、hueJSD ×1、regional ×3、zoneBalance ×1)
- 仍在 1 帧时间内，不影响用户体验

---

## 11. 不改动范围

1. **008a-008e 预设系统** — 全部不动
2. **guard-rules.ts 的 blocking 豁免** — §7.5 通过扩展直接重置 PostProcess 绕过了 catch-22；`artificialityDetected` 拦截随旧架构移除
3. **check_dimension 的 PhaseState 相关字段清理** — 仅删除 check 相关逻辑，不引入新的复杂度
4. **map_atmosphere** — 不动

---

## 12. 实施 Issue 拆分

| Issue | 内容 | 文件 | 预计 |
|:--:|------|------|:--:|
| 009a | 定量指标扩容 | `vision/metrics.ts` (重写) | 1 天 |
| 009b | assess_lighting 串行化 | `tools/assess-lighting.ts` (重写), `vision/prompts.ts` (替换 prompt) | 1.5 天 |
| 009c | Phase 状态机 + 注入适配 | `workflow/phase-machine.ts` (重写 gap 相关 + 新增 tierRoundCount/bestRound/quantitativeSnapshots), `workflow/injections.ts` (buildAnalysisSummary + buildQuantitativeTrendSummary) | 1 天 |
| 009d | check_dimension 删除 | `tools/check-dimension.ts` (删除), `index.ts` (清理) | 0.5 天 |
| 009e | 测试 + 集成验证 | 各文件测试 + 实际 UE 场景验证 | 1 天 |

**总计**: ~5 天

**依赖**: 009a → 009b → 009c/009d → 009e（串行，每阶段依赖前一阶段的类型定义）

---

## 13. 修订记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-11 | v1 | 初版：串行架构、定量扩容、删除 check_dimension |
| 2026-08-11 | v2 | 新增 tier 轮数追踪 (TIER_MAX_ROUNDS=10)、bestRound 追踪、收尾提示机制；新增 buildQuantitativeTrendSummary (跨轮定量趋势 + Delta E 阈值提示)；移除 unchangedRounds 旧机制；注入格式约束 (无 emoji，符号仅用于分层) |
| 2026-08-11 | v3 | Prompt 重写：tier 字段从"症状分类"改为"根因判定"；新增 `__CURRENT_TIER_INFO__` 占位符告知 Vision 当前 tier 可调参数边界；新增准则 8 (Delta E < 3 阈值提示)；新增 §7.5 SETUP 阶段 PostProcess 默认值重置，消除 artificiality catch-22 |
