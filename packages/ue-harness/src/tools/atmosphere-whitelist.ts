/**
 * Issue 010b — 氛围属性 whitelist（简化版：无 dimension 字段）
 *
 * 覆盖 6 类氛围组件中已知的氛围相关属性。
 * 用于 capturePresetState（属性过滤）和 map_atmosphere（属性标注）。
 */

/** 单个属性标注 */
export interface PropertyAnnotation {
	/** 属性名 (如 "lightColor") */
	property: string;
	/** 所属组件类名 */
	componentClass: string;
}

/** 氛围属性列表（去重后，按 (property, componentClass) 唯一） */
export const ATMOSPHERE_WHITELIST: PropertyAnnotation[] = [
	// ── DirectionalLight ──
	{ property: "lightColor", componentClass: "DirectionalLightComponent" },
	{ property: "intensity", componentClass: "DirectionalLightComponent" },
	{ property: "atmosphereSunLightColor", componentClass: "DirectionalLightComponent" },
	{ property: "temperature", componentClass: "DirectionalLightComponent" },
	{ property: "lightSourceAngle", componentClass: "DirectionalLightComponent" },
	{ property: "indirectLightingintensity", componentClass: "DirectionalLightComponent" },
	{ property: "volumetricScatteringintensity", componentClass: "DirectionalLightComponent" },

	// ── SkyLight ──
	{ property: "lightColor", componentClass: "SkyLightComponent" },
	{ property: "intensity", componentClass: "SkyLightComponent" },

	// ── SkyAtmosphere ──
	{ property: "rayleighScatteringColor", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieScatteringColor", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieAbsorptionColor", componentClass: "SkyAtmosphereComponent" },
	{ property: "rayleighExponentialDistribution", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieExponentialDistribution", componentClass: "SkyAtmosphereComponent" },
	{ property: "groundAlbedo", componentClass: "SkyAtmosphereComponent" },

	// ── ExponentialHeightFog ──
	{ property: "fogDensity", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogHeightFalloff", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogInscatteringColor", componentClass: "ExponentialHeightFogComponent" },
	{ property: "directionalInscatteringExponent", componentClass: "ExponentialHeightFogComponent" },
	{ property: "directionalInscatteringColor", componentClass: "ExponentialHeightFogComponent" },
	{ property: "secondFogData", componentClass: "ExponentialHeightFogComponent" },

	// ── VolumetricCloud ──
	{ property: "layerBottomAltitude", componentClass: "VolumetricCloudComponent" },
	{ property: "layerHeight", componentClass: "VolumetricCloudComponent" },

	// ── PostProcessVolume ──
	{ property: "whiteTemp", componentClass: "PostProcessVolume" },
	{ property: "colorSaturation", componentClass: "PostProcessVolume" },
	{ property: "colorContrast", componentClass: "PostProcessVolume" },
	{ property: "colorGamma", componentClass: "PostProcessVolume" },
	{ property: "filmSlope", componentClass: "PostProcessVolume" },
	{ property: "filmToe", componentClass: "PostProcessVolume" },
	{ property: "sceneFringeintensity", componentClass: "PostProcessVolume" },
	{ property: "colorGradingintensity", componentClass: "PostProcessVolume" },
];

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
