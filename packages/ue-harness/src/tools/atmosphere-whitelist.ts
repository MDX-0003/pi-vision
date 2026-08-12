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

/**
 * 氛围属性列表（去重后，按 (property, componentClass) 唯一）。
 *
 * Issue 010c 修正：6 个属性名错误（多余 Color 后缀等），新增 ~30 个遗漏属性。
 * 属性名以 UE list_properties 实际返回名为准。
 */
export const ATMOSPHERE_WHITELIST: PropertyAnnotation[] = [
	// ── DirectionalLight (LightComponent0) ──
	{ property: "lightColor", componentClass: "DirectionalLightComponent" },
	{ property: "intensity", componentClass: "DirectionalLightComponent" },
	{ property: "temperature", componentClass: "DirectionalLightComponent" },
	{ property: "bUseTemperature", componentClass: "DirectionalLightComponent" },
	{ property: "lightSourceAngle", componentClass: "DirectionalLightComponent" },
	{ property: "lightSourceSoftAngle", componentClass: "DirectionalLightComponent" },
	{ property: "indirectLightingIntensity", componentClass: "DirectionalLightComponent" },
	{ property: "volumetricScatteringIntensity", componentClass: "DirectionalLightComponent" },
	{ property: "atmosphereSunLightIndex", componentClass: "DirectionalLightComponent" },
	{ property: "bAtmosphereSunLight", componentClass: "DirectionalLightComponent" },
	{ property: "atmosphereSunDiskColorScale", componentClass: "DirectionalLightComponent" },
	{ property: "specularScale", componentClass: "DirectionalLightComponent" },
	{ property: "diffuseScale", componentClass: "DirectionalLightComponent" },
	{ property: "bCastShadowsOnAtmosphere", componentClass: "DirectionalLightComponent" },
	{ property: "bCastShadowsOnClouds", componentClass: "DirectionalLightComponent" },
	{ property: "cloudScatteredLuminanceScale", componentClass: "DirectionalLightComponent" },
	{ property: "shadowAmount", componentClass: "DirectionalLightComponent" },

	// ── SkyLight (SkyLightComponent0) ──
	{ property: "lightColor", componentClass: "SkyLightComponent" },
	{ property: "intensity", componentClass: "SkyLightComponent" },
	{ property: "indirectLightingIntensity", componentClass: "SkyLightComponent" },
	{ property: "volumetricScatteringIntensity", componentClass: "SkyLightComponent" },
	{ property: "lowerHemisphereColor", componentClass: "SkyLightComponent" },
	{ property: "contrast", componentClass: "SkyLightComponent" },
	{ property: "occlusionTint", componentClass: "SkyLightComponent" },

	// ── SkyAtmosphere (SkyAtmosphereComponent) ──
	{ property: "rayleighScattering", componentClass: "SkyAtmosphereComponent" },
	{ property: "rayleighScatteringScale", componentClass: "SkyAtmosphereComponent" },
	{ property: "rayleighExponentialDistribution", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieScattering", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieScatteringScale", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieExponentialDistribution", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieAbsorption", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieAbsorptionScale", componentClass: "SkyAtmosphereComponent" },
	{ property: "mieAnisotropy", componentClass: "SkyAtmosphereComponent" },
	{ property: "multiScatteringFactor", componentClass: "SkyAtmosphereComponent" },
	{ property: "groundAlbedo", componentClass: "SkyAtmosphereComponent" },
	{ property: "skyLuminanceFactor", componentClass: "SkyAtmosphereComponent" },
	{ property: "atmosphereHeight", componentClass: "SkyAtmosphereComponent" },
	{ property: "heightFogContribution", componentClass: "SkyAtmosphereComponent" },
	{ property: "aerialPerspectiveStartDepth", componentClass: "SkyAtmosphereComponent" },

	// ── ExponentialHeightFog (HeightFogComponent0) ──
	{ property: "fogDensity", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogHeightFalloff", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogMaxOpacity", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogCutoffDistance", componentClass: "ExponentialHeightFogComponent" },
	{ property: "startDistance", componentClass: "ExponentialHeightFogComponent" },
	{ property: "fogInscatteringLuminance", componentClass: "ExponentialHeightFogComponent" },
	{ property: "directionalInscatteringExponent", componentClass: "ExponentialHeightFogComponent" },
	{ property: "directionalInscatteringLuminance", componentClass: "ExponentialHeightFogComponent" },
	{ property: "directionalInscatteringStartDistance", componentClass: "ExponentialHeightFogComponent" },
	{ property: "secondFogData", componentClass: "ExponentialHeightFogComponent" },
	{ property: "volumetricFogAlbedo", componentClass: "ExponentialHeightFogComponent" },
	{ property: "volumetricFogEmissive", componentClass: "ExponentialHeightFogComponent" },
	{ property: "volumetricFogExtinctionScale", componentClass: "ExponentialHeightFogComponent" },
	{ property: "bEnableVolumetricFog", componentClass: "ExponentialHeightFogComponent" },
	{ property: "inscatteringTextureTint", componentClass: "ExponentialHeightFogComponent" },

	// ── VolumetricCloud (VolumetricCloudComponent) ──
	{ property: "layerBottomAltitude", componentClass: "VolumetricCloudComponent" },
	{ property: "layerHeight", componentClass: "VolumetricCloudComponent" },
	{ property: "groundAlbedo", componentClass: "VolumetricCloudComponent" },
	{ property: "planetRadius", componentClass: "VolumetricCloudComponent" },
	{ property: "tracingMaxDistance", componentClass: "VolumetricCloudComponent" },
	{ property: "shadowTracingDistance", componentClass: "VolumetricCloudComponent" },
	{ property: "material", componentClass: "VolumetricCloudComponent" },

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
