/**
 * Issue 003 — 扩展共享状态
 *
 * 工具 execute() 函数需要访问 UeClient 和 VisionClient 实例。
 * 这些在 index.ts 的 session_start 中初始化，
 * 工具通过此模块获取。
 */
import type { UeClient } from "./ue-client/mcp-client.ts";
import type { VisionClient } from "./vision/vision-client.ts";

let _ueClient: UeClient | null = null;
let _visionClient: VisionClient | null = null;

export function setUeClient(client: UeClient | null): void {
	_ueClient = client;
}

export function getUeClient(): UeClient | null {
	return _ueClient;
}

export function setVisionClient(client: VisionClient | null): void {
	_visionClient = client;
}

export function getVisionClient(): VisionClient | null {
	return _visionClient;
}

/** 工具初始化完成检查 */
export function isReady(): boolean {
	return !!_ueClient?.isConnected && !!_visionClient?.isConfigured;
}

// ═══════════════════════════════════════════
// Issue 008c — 活跃参考路径
// ═══════════════════════════════════════════

let _activeReferencePath: string | null = null;

export function setActiveReferencePath(path: string | null): void {
	_activeReferencePath = path;
}

export function getActiveReferencePath(): string | null {
	return _activeReferencePath;
}
