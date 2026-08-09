/**
 * Issue 003 — Vision Prompt 模板
 *
 * 用于 assess_lighting 和 check_dimension 的 Vision 提问模板。
 * 核心策略: 单图独立分析 → 特征提取 → 特征级对比。
 * 不要让 Vision 做双图并排像素对比——画面内容不同，像素对比无意义。
 */

// ── assess_lighting: 8 维度氛围特征提取 ──

/**
 * 单图氛围分析 prompt。
 * Vision 只分析一张图的氛围，不比较两张图。
 * 输出结构化 JSON: { dimension: { rating: 1-5, description: "..." } }
 */
export const ATMOSPHERE_ANALYSIS_PROMPT = `你是一个游戏光照分析助手。

请忽略画面中的具体物体（人、建筑、物体、地面纹理），只分析光照氛围。
对以下 8 个维度，每个维度给出 1-5 的评分和一句话描述。

评分标准:
  1 = 完全不符合
  2 = 稍微符合
  3 = 中等
  4 = 明显符合
  5 = 极致符合

维度:
  1. light_direction   — 光源方向感: 是否能清晰感知主光从哪个方向来、角度多高
  2. color_temperature — 色温: 暖调(偏橙/金) vs 冷调(偏蓝/白)。5=极致暖调, 1=极致冷调
  3. brightness         — 整体亮度: 5=过曝, 4=明亮, 3=适中, 2=偏暗, 1=很暗
  4. contrast           — 对比度: 5=极高对比(亮部过曝暗部死黑), 3=适中, 1=很平淡
  5. color_cast         — 色调偏移: 是否有明显的全局偏色(偏绿/偏紫/偏青)。
                          1=无偏色(自然), 5=严重偏色
  6. saturation         — 饱和度: 5=过饱和, 3=适中, 1=灰蒙蒙
  7. atmosphere         — 大气感/通透度: 5=浓雾/强烈体积光/极不通透,
                          1=完全透明/极清晰/无任何大气效果
  8. shadow_depth       — 阴影深度: 5=阴影近乎黑色(极深), 3=明确阴影但柔和,
                          1=几乎无阴影

返回格式必须是纯 JSON (不要 markdown 代码块):

{
  "light_direction":   { "rating": 3, "description": "主光从右上方约45度角射入" },
  "color_temperature": { "rating": 4, "description": "整体偏暖，金色调" },
  "brightness":        { "rating": 2, "description": "整体偏暗，暗部细节较少" },
  "contrast":          { "rating": 3, "description": "中等对比，亮暗分布均匀" },
  "color_cast":        { "rating": 1, "description": "无明显的全局偏色" },
  "saturation":        { "rating": 3, "description": "饱和度适中" },
  "atmosphere":        { "rating": 2, "description": "较为清晰，仅有轻微大气衰减" },
  "shadow_depth":      { "rating": 4, "description": "阴影较深，轮廓明确" }
}`;

// ── assess_lighting: artificiality 检测 ──

/**
 * 仅用于当前截图的 artificiality 检测。
 * 不与参考图比较——只看当前图是否有"后期滤镜"痕迹。
 */
export const ARTIFICIALITY_PROMPT = `你是一个游戏画面质检助手。

请判断这张游戏截图是否存在"人工后期感"——画面看起来像是加了一个
统一的颜色滤镜（后期调色），而不是真实光照产生的效果。

检测线索:
  · 物体受光面的颜色与阴影的颜色色温不一致
    （受光面是暖的但阴影是冷的 → 可能在 PostProcess 中全局加暖了色温）
  · 所有物体的色温偏移方向和幅度完全一致（真实光照会有位置差异）
  · 画面整体呈现均匀的色调偏移但光源位置/方向没有明显体现

返回格式必须是纯 JSON:

{
  "detected": false,
  "detail": ""
}

如果检测到，detected = true，detail 说明具体表现。`;

// ── check_dimension: 单维度方向判定 ──

/**
 * 单维度快速验证 prompt。
 * 传入参考图和当前截图 + 一个维度名。
 * Vision 只判断一个维度: closer / similar / further。
 *
 * @param dimension 维度名 (如 "color_temperature")
 * @param refRating 参考图在该维度的 rating (1-5)
 */
export function dimensionCheckPrompt(dimension: string, refRating: number): string {
	return `你是一个游戏光照对比助手。

参考图是目标，当前截图是调整后的结果。
只比较 "${dimension}" 这一个维度。

参考图在该维度的评分是 ${refRating}/5。

当前截图相比参考图，在 ${dimension} 上是:
  · closer   — 更接近参考图了
  · similar  — 差不多，没有明显变化
  · further  — 比参考图更远了

给出判定 + 当前截图在该维度的 rating (1-5) + 一句话证据。

返回格式必须是纯 JSON:

{
  "dimension": "${dimension}",
  "verdict": "closer",
  "current_rating": 4,
  "target_rating": ${refRating},
  "evidence": "当前画面色温已从冷白转为暖黄，接近参考图的金色调"
}`;
}
