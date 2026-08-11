# Issue 009 — assess_lighting 串行化 + 定量指标扩容 + Vision 角色重定义

**状态**: 待讨论
**依赖**: Issue 007（assess_lighting 现有实现）、Issue 008a-008e（预设系统）
**PRD**: 本文件

---

## 1. 动机

当前 assess_lighting 存在三个结构性缺陷（见 [LLM 反馈](https://placeholder)）：

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
  Stage 1 (并行, <10ms):
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
| **`tonalRB`** | compare_atmosphere.py §1 | Shadow/Midtone/Highlight 分调性 R/B 比 + directionFlipped | **LLM 反馈的 brightness 被 auto-exposure 污染——分调性数据可直接诊断** |
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

此数值给 Vision 一个**客观的"够不够像"参考线**：如果 Delta E mean < 3 且 Vision 肉眼觉得 close_enough，系统应不再要求继续调参。

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

1. close_enough ≠ 完全一致。这一点至关重要。
   只有当差异**清晰可见**且**可以通过调整 UE5 参数明显缩小**时，才标记 needs_adjustment。
   轻微差异、不确定的差异、由画面内容不同导致的差异(参考图有特殊物体、几何结构不同等)
   ——都应标记为 close_enough。
   参考图和 UE 截图不可能像素级一致，追求完全一致会陷入无限调参。见好就收。

2. 如果 quantitative_report 的某个数字与你肉眼观察有矛盾:
   **以你的肉眼观察为准**，不要盲目信任数字。
   在 suggestion 中解释为什么数字不准。
   例如: "brightness 定量显示 +38.9% 由天空主导，实际 DirectionalLight 照亮的区域已接近参考——此偏差来自 auto-exposure，不应继续压暗主光"

3. tier 定义:
   - Tier 1 = 直射光 / 天光属性 (DirectionalLight, SkyLight 的 lightColor, intensity, temperature, lightSourceAngle)
   - Tier 2 = 大气 / 雾 / 体积云 (SkyAtmosphere, ExponentialHeightFog, VolumetricCloud 的散射、密度、高度等参数)
   - Tier 3 = 后处理 (PostProcessVolume 的 whiteTemp, colorSaturation, colorContrast, colorGamma 等参数)

4. 如果某个 quantitative 差异数值很大, 但你判断**不需要继续调参**:
   仍然在 analysis 中列出此 aspect, 标记 close_enough,
   在 suggestion 中解释"为什么不建议继续调"。

5. 不要输出超过 6 个 analysis 条目。合并微小的同类差异。

6. 只比较光照氛围——光的方向、色温、亮度、饱和度、大气雾感、对比度、阴影深浅。
   不要比较画面中的具体物体、几何结构、纹理。

7. 如果 quantitative_report 中的 tonalRB.directionFlipped 为 true
   (Shadow 和 Highlight 的色温偏移方向相反), 这通常意味着 PostProcessVolume 存在人工后期调色。
   请勿输出单独的 "post_processing" aspect——而是分析哪些氛围维度的表现受后处理影响,
   并在对应 aspect 的 suggestion 中注明。

## Tier 间的调参顺序

调整必须按 Tier 顺序进行:
  - Tier 1 确定光源色温、亮度、方向 → 解决全局颜色基调
  - Tier 2 确定大气散射、雾效 → 解决氛围通透度和暖紫黄昏等大气特征
  - Tier 3 微调后处理 → 解决对比度和饱和度细节

请严格按此顺序给出建议。如果 Tier 1 仍有 needs_adjustment, Tier 2/3 的 aspect 也可以列出,
但在 suggestion 中注明"建议在 Tier 1 完成后处理"。
```

### 4.2 Prompt 生成方式

`prompts.ts` 中 `ASSESS_LIGHTING_PROMPT` 是静态的模板。`quantitative_report` 是一个占位符 `__QUANTITATIVE_REPORT__`，由 `assess-lighting.ts` 的 `executeAssessLighting` 在运行时做 `.replace()` 替换为 JSON 字符串。

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
  const prompt = ASSESS_LIGHTING_PROMPT.replace("__QUANTITATIVE_REPORT__", quantReportStr);

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
  unchangedRounds: number;
  artificialityDetected: boolean;          // 保留但不再由代码判定——Vision 在 analysis 中体现
  blockingAspects: string[];               // 替换 blockingDimensions (aspect 名列表)

  // Issue 008c 保留
  lastTagResult?: TagResult;

  // 移除的字段:
  // - checkCount
  // - lastCheckDimension
  // - consecutiveSameDimensionFurther
  // - lastQuantitative
  // - quantitativeHistory
  // - lastGapEntries
  // - blockingDimensions
}
```

### 7.2 Tier 升级逻辑

```typescript
function allTierAspectsClosed(analysis: AnalysisEntry[], tier: number): boolean {
  const tierAspects = analysis.filter(a => a.tier === tier);
  if (tierAspects.length === 0) return true;
  return tierAspects.every(a => a.status === "close_enough");
}

export function onAssessLighting(analysis: AnalysisEntry[], overall: string): PhaseState {
  state.assessCount++;
  state.lastAnalysis = analysis;
  state.lastOverall = overall;

  // blocking aspects: 所有 status=needs_adjustment 的 aspect
  state.blockingAspects = analysis
    .filter(a => a.status === "needs_adjustment")
    .map(a => a.aspect);

  // unchangedRounds: 对比上次 analysis
  // 如果 aspect 集合和各自的 status 完全相同 → unchangedRounds++
  // 否则 → unchangedRounds = 0

  // Tier 升级
  switch (state.phase) {
    case "SETUP":
      state.phase = "TUNING";
      state.tier = 1;
      break;
    case "TUNING":
      if (allTierAspectsClosed(analysis, state.tier)) {
        if (state.tier === 1) state.tier = 2;
        else if (state.tier === 2) state.phase = "POSTPROCESS_SETUP";
        else if (state.tier === 3) state.phase = "FINAL";
      }
      break;
    case "POSTPROCESS_SETUP":
      state.phase = "TUNING";
      state.tier = 3;
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
| `computeUnchangedRounds()` | analysis 条目本身的稳定性已足够 |
| `storeQuantitative()` | quantitative 完整存储在 assess_lighting 返回中 |
| `getDimensionTrends()` | 维度概念移除 |
| `isTierOneSettled()` | 替换为 `allTierAspectsClosed(analysis, 1)` |
| `onCheckDimension()` | check_dimension 删除 |
| `getFurtherStage()` | check_dimension 删除 |
| `checkLimits()` 中 check/further 相关限制 | check_dimension 删除 |

---

## 8. before_agent_start 注入适配

### 8.1 buildAnalysisSummary (替换 buildGapSummary)

```
## 当前分析状态

Tier 1:
  [needs_adjustment] brightness
    Shadow区域接近参考(R/B仅+0.03)，但全局亮度+38.9%由天空主导。
    → 建议: 微降DirectionalLight intensity至0.08-0.10，进入Tier 3后调autoExposureBias

  [close_enough] ✅ color_temperature
    所有调性(Shadow/Midtone/Highlight)R/B比在±0.05内，色温已达标

Tier 2:
  [needs_adjustment] atmosphere_haze
    Chroma偏低-3.1(Delta E horizon区域9.8)，天空雾感不足
    → 建议: 增加MieScatteringScale至0.03-0.05

Vision 总评: Tier 1 仅brightness存在可见偏差(Shadow已达标，天空主导)，
建议进入Tier 2解决atmosphere后再回看是否需要Tier 3微调。

assess_lighting: 2/15
```

### 8.2 unspecific 说明 (保持)

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
2. **guard-rules.ts 的 blocking 豁免** — 用户要求放一放，等调参依据解决后再讨论
3. **check_dimension 的 PhaseState 相关字段清理** — 仅删除 check 相关逻辑，不引入新的复杂度
4. **map_atmosphere** — 不动

---

## 12. 实施 Issue 拆分

| Issue | 内容 | 文件 | 预计 |
|:--:|------|------|:--:|
| 009a | 定量指标扩容 | `vision/metrics.ts` (重写) | 1 天 |
| 009b | assess_lighting 串行化 | `tools/assess-lighting.ts` (重写), `vision/prompts.ts` (替换 prompt) | 1.5 天 |
| 009c | Phase 状态机 + 注入适配 | `workflow/phase-machine.ts` (重写 gap 相关), `workflow/injections.ts` (buildAnalysisSummary) | 0.5 天 |
| 009d | check_dimension 删除 | `tools/check-dimension.ts` (删除), `index.ts` (清理) | 0.5 天 |
| 009e | 测试 + 集成验证 | 各文件测试 + 实际 UE 场景验证 | 1 天 |

**总计**: ~4.5 天

**依赖**: 009a → 009b → 009c/009d → 009e（串行，每阶段依赖前一阶段的类型定义）
