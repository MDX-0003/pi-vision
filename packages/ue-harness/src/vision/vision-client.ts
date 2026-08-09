/**
 * Issue 003 — Vision API 客户端
 *
 * 独立的 Vision LLM 调用。支持两种 API 格式:
 *   - Anthropic Messages API (baseUrl 不以 /v1 结尾)
 *   - OpenAI-compatible Chat Completions API (baseUrl 以 /v1 结尾)
 *
 * 自动检测: baseUrl 已含 /v1 → OpenAI 格式；否则 → Anthropic 格式。
 */
import type { UeHarnessConfig } from "../ue-client/types.ts";

// ── 类型 ──

export interface VisionRequest {
	prompt: string;
	images: VisionImage[];
	maxTokens?: number;
}

export interface VisionImage {
	base64: string;
	mediaType?: string; // default: "image/png"
}

export interface VisionResponse {
	text: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

// ── 客户端 ──

export class VisionClient {
	private config: UeHarnessConfig;
	/** true = OpenAI-compatible, false = Anthropic */
	private _useOpenAI: boolean;

	constructor(config: UeHarnessConfig) {
		this.config = config;
		// 自动检测: baseUrl 以 /v1 结尾 (如阿里云兼容模式) → OpenAI 格式
		const base = (config.visionApiBaseUrl || "").replace(/\/+$/, "");
		this._useOpenAI = base.endsWith("/v1");
	}

	get isConfigured(): boolean {
		return !!this.config.visionApiKey;
	}

	// ── 公共接口 ──

	async send(request: VisionRequest): Promise<VisionResponse> {
		if (!this.config.visionApiKey) {
			throw new Error("VISION_API_KEY not configured");
		}
		return this._useOpenAI ? this.sendOpenAI(request) : this.sendAnthropic(request);
	}

	async sendAndParse<T>(request: VisionRequest): Promise<T> {
		const response = await this.send(request);
		let jsonText = response.text.trim();
		const m = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (m) jsonText = m[1].trim();
		try {
			return JSON.parse(jsonText) as T;
		} catch {
			throw new Error(
				`Vision returned non-JSON (${response.text.length} chars): ${response.text.substring(0, 200)}`,
			);
		}
	}

	// ── Anthropic 格式 ──

	private async sendAnthropic(request: VisionRequest): Promise<VisionResponse> {
		const base = (this.config.visionApiBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
		const model = this.config.visionModelId || "claude-sonnet-5-20251001";
		const maxTokens = request.maxTokens ?? this.config.visionMaxTokens ?? 3000;

		const content: any[] = request.images.map((img) => ({
			type: "image",
			source: { type: "base64", media_type: img.mediaType || "image/png", data: img.base64 },
		}));
		content.push({ type: "text", text: request.prompt });

		const r = await fetch(`${base}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.config.visionApiKey!,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
			signal: AbortSignal.timeout(120_000),
		});

		if (!r.ok) {
			const et = await r.text().catch(() => "");
			throw new Error(`Vision API ${r.status}: ${et.substring(0, 200)}`);
		}

		const d = (await r.json()) as any;
		return {
			text: (d.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join(""),
			usage: d.usage
				? { inputTokens: d.usage.input_tokens ?? 0, outputTokens: d.usage.output_tokens ?? 0 }
				: undefined,
		};
	}

	// ── OpenAI 兼容格式 ──

	private async sendOpenAI(request: VisionRequest): Promise<VisionResponse> {
		const base = (this.config.visionApiBaseUrl || "").replace(/\/+$/, "");
		const model = this.config.visionModelId || "gpt-4o";
		const maxTokens = request.maxTokens ?? this.config.visionMaxTokens ?? 3000;

		// OpenAI 格式的图片 content
		const content: any[] = request.images.map((img) => ({
			type: "image_url",
			image_url: { url: `data:${img.mediaType || "image/png"};base64,${img.base64}` },
		}));
		content.push({ type: "text", text: request.prompt });

		const r = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.visionApiKey}`,
			},
			body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
			signal: AbortSignal.timeout(120_000),
		});

		if (!r.ok) {
			const et = await r.text().catch(() => "");
			throw new Error(`Vision API ${r.status}: ${et.substring(0, 200)}`);
		}

		const d = (await r.json()) as any;
		return {
			text: d.choices?.[0]?.message?.content || "",
			usage: d.usage
				? {
						inputTokens: d.usage.prompt_tokens ?? 0,
						outputTokens: d.usage.completion_tokens ?? 0,
					}
				: undefined,
		};
	}
}
