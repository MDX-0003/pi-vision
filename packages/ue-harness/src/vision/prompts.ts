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

// ═══════════════════════════════════════════
// Issue 008a — 动态标签分析 Prompt
// ═══════════════════════════════════════════

import { CONTROLLED_DIMENSIONS, getEffectiveVocabulary, type ControlledTagDimension } from "./analyzer.ts";

/** 基础标签值的中文描述映射（仅基础值有描述，自定义值只列出英文名） */
const TAG_DESCRIPTIONS: Record<ControlledTagDimension, Array<{ value: string; desc: string }>> = {
	time_of_day: [
		{ value: "golden_hour", desc: "温暖的倾斜低角度日光，长阴影，橙/金色调" },
		{ value: "midday", desc: "明亮的顶光，短阴影，中性白光" },
		{ value: "dusk", desc: "黄昏，太阳低于地平线但天空仍有色彩，紫/粉色调" },
		{ value: "night", desc: "夜晚场景，月光或人造光源照明" },
		{ value: "dawn", desc: "清晨，冷调淡色，太阳接近地平线" },
		{ value: "overcast", desc: "阴天漫射光，无明确太阳方向，灰调天空感" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	color_palette: [
		{ value: "warm", desc: "全局暖调（橙/金色）" },
		{ value: "cool", desc: "全局冷调（蓝/白）" },
		{ value: "neutral", desc: "自然中性色调" },
		{ value: "warm_cool_contrast", desc: "画面不同区域有明显色温差异（暖高光 + 冷阴影）" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	atmosphere: [
		{ value: "clear", desc: "完全清晰，无任何大气效果" },
		{ value: "light_fog", desc: "轻微雾气，远处稍有衰减" },
		{ value: "heavy_fog", desc: "浓雾，近处也可见明显雾效" },
		{ value: "mist", desc: "薄雾，地面附近有轻纱感" },
		{ value: "haze", desc: "霾，远距离衰减但无体积感" },
		{ value: "storm", desc: "暴风雨/沙尘暴，极端天气效果" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	light_direction: [
		{ value: "front", desc: "主光从相机方向来（顺光）" },
		{ value: "side", desc: "主光从侧面来（侧光）" },
		{ value: "back", desc: "主光从被摄体后方来（逆光）" },
		{ value: "top", desc: "主光从正上方来（顶光）" },
		{ value: "ambient", desc: "无明显方向，全方向漫射" },
		{ value: "low_angle", desc: "主光以低角度射入（斜射）" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
	mood: [
		{ value: "bright", desc: "明亮愉快" },
		{ value: "dark", desc: "黑暗沉重" },
		{ value: "moody", desc: "氛围感强，情绪化" },
		{ value: "vibrant", desc: "鲜艳活泼" },
		{ value: "muted", desc: "柔和低沉" },
		{ value: "dramatic", desc: "戏剧化，强对比" },
		{ value: "unspecified", desc: "以上皆不符合" },
	],
};

/** 动态生成标签分析 prompt，自动纳入最新的有效词汇表 */
export function buildTaggingPrompt(): string {
	let prompt = `你是一个游戏光照分析助手。

分析这张图片的光照氛围，返回结构化标签。

对以下 5 个维度，每个维度从列出的选项中选择最匹配的一个值。
如果所有选项都不符合图片特征，选择 "unspecified"。
你必须从列出的选项中选择——不要创造新值。

维度:
`;

	for (const dim of CONTROLLED_DIMENSIONS) {
		const values = getEffectiveVocabulary(dim);
		const descMap = TAG_DESCRIPTIONS[dim];
		prompt += `  ${dim}: [${values.join(", ")}]\n`;
		for (const entry of descMap) {
			if (values.includes(entry.value)) {
				prompt += `    - ${entry.value.padEnd(20)} — ${entry.desc}\n`;
			}
		}
		// 自定义值（无中文描述）
		const customValues = values.filter((v) => !descMap.find((d) => d.value === v));
		for (const cv of customValues) {
			prompt += `    - ${cv.padEnd(20)} — (用户自定义标签)\n`;
		}
		prompt += "\n";
	}

	prompt += `此外:
  - description: 1-3 句自然语言描述该图的光照氛围
  - freeformTags: 0-5 个上述维度未覆盖的场景特征词
    (如 "ocean_horizon", "mountain_silhouette", "indoor", "god_rays")

返回纯 JSON（无 markdown 代码块）:

{
  "description": "Warm golden hour sunlight over ocean horizon...",
  "tags": { "time_of_day": "golden_hour", "color_palette": "warm" },
  "freeformTags": ["ocean_horizon", "god_rays"]
}`;

	return prompt;
}