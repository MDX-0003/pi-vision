/**
 * Issue 012 — Tier 注册表（数据驱动的调参阶段定义）
 *
 * 单一数据源：定义"有哪些 tier、什么顺序、怎么归类工具调用、怎么描述"。
 * 其余模块（phase-machine / guard-rules / injections / assess-lighting / prompts）
 * 全部从这里派生，不再硬编码 tier 数字。
 *
 * 新增/删除/重排 tier：只改 TIER_ORDER（数组顺序即调参顺序）。
 */

// ── 类型 ──

/** 进入本 tier 前需要先切到的 phase（目前仅 PostProcessVolume 用 POSTPROCESS_SETUP） */
export type TierPrePhase = "POSTPROCESS_SETUP";

export interface TierDef {
	/** tier 编号（1-based），数组顺序即调参顺序 */
	id: number;
	/** 中文标签（"光源"/"大气"/"后期"） */
	label: string;
	/** 本 tier 可调的组件（英文，用于 prompt） */
	components: string;
	/** 本 tier 可调的属性（用于 prompt） */
	properties: string;
	/** resolveTier 分类关键词：匹配 toolName / refPath / property 名的子串 */
	keywords: string[];
	/** 进入本 tier 前先切到的 phase */
	prePhase?: TierPrePhase;
}

// ── 数据 ──

export const TIER_ORDER: TierDef[] = [
	{
		id: 1,
		label: "光源",
		components: "DirectionalLight / SkyLight",
		properties: "lightColor, intensity, temperature, lightSourceAngle",
		keywords: [
			"DirectionalLight",
			"SkyLight",
			"LightColor",
			"lightColor",
			"intensity",
			"lightSourceAngle",
			"temperature",
		],
	},
	{
		id: 2,
		label: "大气",
		components: "SkyAtmosphere / ExponentialHeightFog / VolumetricCloud",
		properties: "散射、密度、高度等",
		keywords: [
			"SkyAtmosphere",
			"ExponentialHeightFog",
			"VolumetricCloud",
			"fogDensity",
			"fogHeightFalloff",
			"fogInscatteringColor",
			"layerBottomAltitude",
			"layerHeight",
		],
	},
	{
		id: 3,
		label: "后期",
		components: "PostProcessVolume",
		properties: "whiteTemp, colorSaturation, colorContrast, colorGamma, autoExposureBias 等",
		keywords: [
			"PostProcessVolume",
			"whiteTemp",
			"colorSaturation",
			"colorContrast",
			"colorGamma",
			"filmSlope",
			"filmToe",
			"sceneFringeIntensity",
			"colorGradingIntensity",
			"autoExposureBias",
		],
		prePhase: "POSTPROCESS_SETUP",
	},
];

// ── 派生: keyword → tier 的扁平表（保持 TIER_ORDER 内顺序，供 resolveTier 首命中） ──

const KEYWORD_TIERS: Array<[string, number]> = TIER_ORDER.flatMap((t) =>
	t.keywords.map((k): [string, number] => [k, t.id]),
);

// ── 查询 ──

export function getTierDef(id: number): TierDef | undefined {
	return TIER_ORDER.find((t) => t.id === id);
}

/** 下一个 tier（纯函数）。返回 null 表示当前是最后一个 tier。 */
export function nextTier(id: number): TierDef | null {
	const idx = TIER_ORDER.findIndex((t) => t.id === id);
	if (idx < 0 || idx + 1 >= TIER_ORDER.length) return null;
	return TIER_ORDER[idx + 1];
}

export function tierCount(): number {
	return TIER_ORDER.length;
}

// ── 工具调用归类 ──

/** 从工具参数提取 actor refPath（set_properties 用 instance.refPath；set_actor_transform 用 actor.refPath，step 2 扩展） */
export function extractRefPath(args: Record<string, unknown>): string | undefined {
	const instance = args.instance;
	const refPath = typeof instance === "object" && instance !== null
		? (instance as Record<string, unknown>).refPath
		: undefined;
	return typeof refPath === "string" ? refPath : undefined;
}

/** 从工具参数提取写入目标 (refPath + 待写 props)。兼容 properties 对象 / values JSON 字符串两种形式。 */
export function extractWriteTarget(args: Record<string, unknown>): { refPath: string; props: Record<string, unknown> } | null {
	const refPath = extractRefPath(args);
	if (!refPath) return null;

	// properties 对象形式
	const propsObj = args.properties;
	if (propsObj && typeof propsObj === "object" && !Array.isArray(propsObj)) {
		return { refPath, props: propsObj as Record<string, unknown> };
	}

	// values JSON 字符串形式
	const values = args.values;
	if (typeof values === "string") {
		try {
			const parsed = JSON.parse(values);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return { refPath, props: parsed as Record<string, unknown> };
			}
		} catch { /* ignore */ }
	}
	return null;
}

/**
 * 把一个工具调用归类到某个 tier（关键词子串匹配，首命中返回）。
 *
 * 匹配对象（优先级从高到低）：toolName → refPath → values(字符串) → properties(对象 key)。
 * 与旧 guard-rules.resolveTier 行为完全一致（仅数据源改为 TIER_ORDER + refPath 抽取复用 extractRefPath）。
 */
export function resolveTier(toolName: string, args: Record<string, unknown>): number | null {
	// Pass 1: 工具名
	for (const [kw, tier] of KEYWORD_TIERS) {
		if (toolName.includes(kw)) return tier;
	}

	// Pass 2: refPath
	const refPath = extractRefPath(args);
	if (refPath) {
		for (const [kw, tier] of KEYWORD_TIERS) {
			if (refPath.includes(kw)) return tier;
		}
	}

	// Pass 3/4: values / properties
	const values = args.values ?? args.properties;
	if (typeof values === "string") {
		for (const [kw, tier] of KEYWORD_TIERS) {
			if (values.includes(kw)) return tier;
		}
	} else if (typeof values === "object" && values !== null) {
		const keys = Object.keys(values as Record<string, unknown>);
		for (const [kw, tier] of KEYWORD_TIERS) {
			if (keys.some((k) => k.includes(kw))) return tier;
		}
	}

	return null;
}

// ── 渲染 ──

/** TUNING 模板用的"只能调 X 的属性 (Y)"一行 */
export function buildTunableLine(id: number): string {
	const def = getTierDef(id);
	if (!def) return "";
	return `只能调 ${def.components} 的属性${def.properties ? ` (${def.properties})` : ""}。`;
}

/** Vision prompt 规则 3 用的 tier 列表（"- Tier N: components (properties)"） */
export function buildTierListDescription(): string {
	return TIER_ORDER.map((t) => `   - Tier ${t.id}: ${t.components} (${t.properties})`).join("\n");
}
