/**
 * Issue 003 — 截图工具封装
 *
 * 封装 ViewportCaptureToolset.CaptureViewportImage，
 * 返回文件路径 → fs.readFileSync → base64 → 供 Vision 调用。
 */
import { existsSync, readFileSync } from "fs";
import type { UeToolCaller } from "../ue-client/types.ts";

/** 截图结果 */
export interface CaptureResult {
	/** 截图文件绝对路径 */
	filePath: string;
	/** base64 编码的 PNG 数据 (不含 data URI 前缀) */
	base64: string;
	/** 文件大小 (bytes) */
	fileSize: number;
	/** 截图耗时 (ms) */
	elapsedMs: number;
}

/**
 * 调用 UE ViewportCaptureToolset 截图。
 *
 * @param ueClient 已连接的 UE MCP 客户端
 * @param resolutionMultiplier 分辨率倍数 (默认 1.0, 范围 1.0-10.0)
 * @returns CaptureResult, 或 null (截图失败)
 */
export async function captureViewport(
	caller: UeToolCaller,
	resolutionMultiplier: number = 1.0,
): Promise<CaptureResult | null> {
	const start = Date.now();

	const result = await caller.callTool("ViewportCaptureToolset.ViewportCaptureToolset.CaptureViewportImage", {
		ResolutionMultiplier: resolutionMultiplier,
	});

	if (result.isError) {
		return null;
	}

	// 解析 returnValue: 文件路径字符串
	let filePath: string;
	try {
		const parsed = JSON.parse(result.text);
		filePath = parsed.returnValue ?? parsed.returnValue;
	} catch {
		// 可能直接返回文件路径字符串
		filePath = result.text.trim();
	}

	if (!filePath || !existsSync(filePath)) {
		return null;
	}

	const buffer = readFileSync(filePath);
	const base64 = buffer.toString("base64");
	const elapsed = Date.now() - start;

	return {
		filePath,
		base64,
		fileSize: buffer.length,
		elapsedMs: elapsed,
	};
}
