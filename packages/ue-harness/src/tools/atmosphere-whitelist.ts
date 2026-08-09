/**
 * Issue 004 — 氛围属性 whitelist
 *
 * 硬编码的 dimension → 属性名模式映射。
 * 覆盖 6 类氛围组件中已知的氛围相关属性。
 * Vision classify 不可用时自动退级到此列表。
 */

/** 单个属性的维度标注 */
export interface PropertyAnnotation {
	/** 属性名 (如 "lightColor") */
	property: string;
	/** 8 维度之一 */
	dimension: string;
	/** 所属组件类名 */
	componentClass: string;
}

/** 维度→属性模式列表（属性名对组件类做模糊匹配） */
export const ATMOSPHERE_WHITELIST: PropertyAnnotation[] = [
	// ── DirectionalLight ──
	{ property: "lightColor", dimension: "color_temperature", componentClass: "DirectionalLightComponent" },
	{ property: "lightColor", dimension: "brightness", componentClass: "DirectionalLightComponent" },
	{ property: "intensity", dimension: "brightness", componentClass: "DirectionalLightComponent" },
	{ property: "atmosphereSunLightColor", dimension: "color_temperature", componentClass: "DirectionalLightComponent" },
	{ property: "temperature", dimension: "color_temperature", componentClass: "DirectionalLightComponent" },
	{ property: "lightSourceAngle", dimension: "light_direction", componentClass: "DirectionalLightComponent" },
	{ property: "indirectLightingintensity", dimension: "brightness", componentClass: "DirectionalLightComponent" },
	{ property: "volumetricScatteringintensity", dimension: "atmosphere", componentClass: "DirectionalLightComponent" },

	// ── SkyLight ──
	{ property: "lightColor", dimension: "color_temperature", componentClass: "SkyLightComponent" },
	{ property: "intensity", dimension: "brightness", componentClass: "SkyLightComponent" },

	// ── SkyAtmosphere ──
	{ property: "rayleighScatteringColor", dimension: "sky", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieScatteringColor", dimension: "atmosphere", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieAbsorptionColor", dimension: "atmosphere", componentClass: "SkyAtmosphereComponent" },
	{ property: "rayleighExponentialDistribution", dimension: "sky", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieExponentialDistribution", dimension: "atmosphere", componentClass: "SkyAtmosphereComponent" },
	{ property: "groundAlbedo", dimension: "brightness", componentClass: "SkyAtmosphereComponent" },

	// ── ExponentialHeightFog ──
	{ property: "fogDensity", dimension: "atmosphere", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogHeightFalloff", dimension: "atmosphere", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogInscatteringColor", dimension: "atmosphere", componentClass: "ExponentialHeightFogComponent" },
	{
		property: "fogInscatteringColor",
		dimension: "color_temperature",
		componentClass: "ExponentialHeightFogComponent",
	},
	{
		property: "directionalInscatteringExponent",
		dimension: "light_direction",
		componentClass: "ExponentialHeightFogComponent",
	},
	{
		property: "directionalInscatteringColor",
		dimension: "color_temperature",
		componentClass: "ExponentialHeightFogComponent",
	},
	{ property: "secondFogData", dimension: "atmosphere", componentClass: "ExponentialHeightFogComponent" },

	// ── VolumetricCloud ──
	{ property: "layerBottomAltitude", dimension: "sky", componentClass: "VolumetricCloudComponent" },
	{ property: "layerHeight", dimension: "sky", componentClass: "VolumetricCloudComponent" },

	// ── PostProcessVolume ──
	{ property: "whiteTemp", dimension: "color_temperature", componentClass: "PostProcessVolume" },
	{ property: "colorSaturation", dimension: "saturation", componentClass: "PostProcessVolume" },
	{ property: "colorContrast", dimension: "contrast", componentClass: "PostProcessVolume" },
	{ property: "colorGamma", dimension: "contrast", componentClass: "PostProcessVolume" },
	{ property: "filmSlope", dimension: "contrast", componentClass: "PostProcessVolume" },
	{ property: "filmToe", dimension: "contrast", componentClass: "PostProcessVolume" },
	{ property: "sceneFringeintensity", dimension: "color_cast", componentClass: "PostProcessVolume" },
	{ property: "colorGradingintensity", dimension: "color_cast", componentClass: "PostProcessVolume" },
];

/** 维度名 → 人类可读标签 */
export const DIMENSION_LABELS: Record<string, string> = {
	light_direction: "光源方向",
	color_temperature: "色温",
	brightness: "亮度",
	contrast: "对比度",
	color_cast: "色调偏移",
	saturation: "饱和度",
	atmosphere: "大气感/通透度",
	sky: "天空表现",
	shadow_depth: "阴影深度",
};

/** Tier 映射 */
export const DIMENSION_TIER: Record<string, number> = {
	light_direction: 1,
	color_temperature: 1,
	brightness: 1,
	shadow_depth: 1,
	atmosphere: 2,
	sky: 2,
	contrast: 3,
	color_cast: 3,
	saturation: 3,
};

/** 6 类氛围组件的 find_actors glob + 组件键名 */
export const ATMOSPHERE_COMPONENT_GLOBS = [
	{
		glob: "*DirectionalLight*",
		tier: 1,
		label: "CORE_LIGHTING",
		actorClass: "DirectionalLight",
		compKeys: ["directionalLightComponent"],
		compClass: "DirectionalLightComponent",
	},
	{
		glob: "*SkyLight*",
		tier: 1,
		label: "CORE_LIGHTING",
		actorClass: "SkyLight",
		compKeys: ["lightComponent"],
		compClass: "SkyLightComponent",
	},
	{
		glob: "*SkyAtmosphere*",
		tier: 2,
		label: "ATMOSPHERE",
		actorClass: "SkyAtmosphere",
		compKeys: ["skyAtmosphereComponent"],
		compClass: "SkyAtmosphereComponent",
	},
	{
		glob: "*ExponentialHeightFog*",
		tier: 2,
		label: "ATMOSPHERE",
		actorClass: "ExponentialHeightFog",
		compKeys: ["component"],
		compClass: "ExponentialHeightFogComponent",
	},
	{
		glob: "*VolumetricCloud*",
		tier: 2,
		label: "ATMOSPHERE",
		actorClass: "VolumetricCloud",
		compKeys: ["volumetricCloudComponent"],
		compClass: "VolumetricCloudComponent",
	},
	{
		glob: "*PostProcessVolume*",
		tier: 3,
		label: "POSTPROCESS",
		actorClass: "PostProcessVolume",
		compKeys: [],
		compClass: "PostProcessVolume",
	},
];
