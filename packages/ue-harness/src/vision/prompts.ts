/**
 * Issue 009b — Vision Prompt 模板
 *
 * assess_lighting: 串行架构 — Vision 综合定量数据 + 双图对比，输出结构化分析。
 * 不再有单独的 artificiality 检测和 check_dimension prompt。
 */

// ═══════════════════════════════════════════
// Issue 009 — assess_lighting 氛围分析 Prompt
// ═══════════════════════════════════════════

/**
 * 串行架构核心 prompt。包含两个运行时占位符:
 *   __QUANTITATIVE_REPORT__ — JSON.stringify(quantitative)
 *   __CURRENT_TIER_INFO__  — 当前 tier 编号 + 可调参数列表
 */
export const ASSESS_LIGHTING_PROMPT = `你是一个 UE5 光照分析助手。

你会收到 2 张图片:
  - 第 1 张: 参考图 (目标效果)
  - 第 2 张: 当前 UE 视口截图

此外，你还会收到一份自动计算的定量像素对比数据 (quantitative_report)。

## 你的任务是:

列出当前画面与参考图之间存在的**明显、肉眼可见、可通过调 UE5 参数改善**的差异。
对每一项差异给出结构化判断。

## quantitative_report

以下数据由代码自动计算 (不需要你复述):
__QUANTITATIVE_REPORT__

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
   对于数值差距最大的 aspect，如果没有明显的视觉差异，应标记 close_enough。`;

// ═══════════════════════════════════════════
// Issue 010a — 简化标签分析 Prompt (开放式标签，无受控维度)
// ═══════════════════════════════════════════

/** 生成开放式标签分析 prompt */
export function buildTaggingPrompt(): string {
	return `你是一个游戏光照分析助手。

分析这张图片的光照氛围，返回结构化标签。

输出 JSON:
{
  "description": "1-2 句中文描述该图的光照氛围特征",
  "tags": ["golden_hour", "ocean_horizon", "god_rays"]
}

规则:
- description: 1-2 句中文，描述整体光照氛围
- tags: 0-5 个标签，用于与预设库匹配。标签应描述氛围特征（色温、时段、方向、情绪、场景元素等）
- 标签可以是中文或英文，优先英文常用术语

返回纯 JSON（无 markdown 代码块）。`;
}
