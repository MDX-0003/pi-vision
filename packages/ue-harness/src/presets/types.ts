/**
 * Issue 008a — 预设系统类型定义
 */

import type { PresetTags } from "../vision/analyzer.ts";

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
	tags: PresetTags; // 受控标签（5 维度，用于匹配）
	freeformTags: string[]; // 自由标签（加分项）
	screenshot: string; // 截图文件名（相对预设目录）
	actors: Record<string, PresetActor>;
	postprocessReset: boolean;
	created: string; // ISO 8601
}

/** 预设匹配结果 */
export interface PresetMatch {
	name: string;
	description: string;
	score: number; // 0-1
	matchedDimensions: string[]; // 具体哪些受控标签匹配
}
