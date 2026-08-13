/**
 * Issue 008a — 预设系统类型定义
 */

// PresetTags removed in Issue 010a — tags are now a flat string[]

/** 单个 actor 的属性快照 */
export interface PresetActor {
	/** UE 中该 actor 的完整 refPath */
	refPath: string;
	/** DirectionalLight 的 transform（旋转），其他组件无此字段 */
	transform?: { rotation: { Pitch: number; Yaw: number; Roll: number } };
	/** 组件 → 属性键值对 */
	components: Record<string, Record<string, unknown>>;
}

/** 预设条目（存储于 preset.json） */
export interface PresetEntry {
	name: string;
	description: string; // Vision 自动生成的自然语言描述
	tags: string[]; // 开放式标签（0-5 个），用于匹配
	screenshot: string; // 截图文件名（相对预设目录）
	actors: Record<string, PresetActor>;
	created: string; // ISO 8601
}

/** 预设匹配结果 */
export interface PresetMatch {
	name: string;
	description: string;
	score: number; // RRF 融合分（越大越匹配）
}

// ═══════════════════════════════════════════
// Issue 011 — 混合检索类型
// ═══════════════════════════════════════════

/** 参考图查询（来自 assess_lighting Stage1 的 analyzeAndTag） */
export interface PresetQuery {
	/** 开放式标签，0-5 个 */
	tags: string[];
	/** Vision 生成的描述（1-2 句） */
	description: string;
}

/**
 * 单个打分器。同步返回原始分数（范围不要求归一化，RRF 只关心排名）。
 * 当前实现: Jaccard / BM25 / embedding cosine。
 */
export type PresetScorer = (query: PresetQuery, preset: PresetEntry) => number;
