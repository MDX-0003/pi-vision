/**
 * Issue 012 review (S4) — classifyResultText 文本错误分类测试
 *
 * UE MCP 有时把错误作为"成功"结果返回 (SDK isError=false, 文本含错误标记)。
 * 扩展必须识别, 否则 journal 把失败写记成成功。
 *
 * 运行: node --import tsx test/mcp-error-classify.test.ts
 */

import { classifyResultText } from "../src/ue-client/mcp-client.ts";

const PASS = "✅";
const FAIL = "❌";
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) { console.log(`${PASS} ${name}${detail ? ` — ${detail}` : ""}`); passed++; }
	else { console.log(`${FAIL} ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function main() {
	console.log("=".repeat(60));
	console.log("S4 — classifyResultText (text error detection)");
	console.log("=".repeat(60));

	// 1. [server_error] + Parameter error → validation_error (不触发重连重试)
	const c1 = classifyResultText("[server_error] Parameter error: /Temp/...Settings is not valid Object for property 'instance'.");
	check("1.1 [server_error] Parameter error → isError", c1.isError === true);
	check("1.2 归类 validation_error (非 server_error)", c1.errorType === "validation_error", c1.errorType ?? "?");

	// 2. [unknown] MCP error -32000 → server_error (连接断开, 应重连)
	const c2 = classifyResultText("[unknown] MCP error -32000: Connection closed");
	check("2.1 [unknown] MCP error → isError", c2.isError === true);
	check("2.2 归类 server_error", c2.errorType === "server_error", c2.errorType ?? "?");

	// 3. [timeout]
	const c3 = classifyResultText("[timeout] request exceeded 60000ms");
	check("3.1 [timeout] → isError", c3.isError === true);
	check("3.2 归类 timeout", c3.errorType === "timeout", c3.errorType ?? "?");

	// 4. [validation_error] / [tool_not_found] / [unknown] 直接归类
	check("4.1 [validation_error] → validation_error", classifyResultText("[validation_error] bad value").errorType === "validation_error");
	check("4.2 [tool_not_found] → tool_not_found", classifyResultText("[tool_not_found] no such tool").errorType === "tool_not_found");
	check("4.3 [unknown] → unknown", classifyResultText("[unknown] something odd").errorType === "unknown");

	// 5. 正常结果不误报
	check("5.1 returnValue true → 不误报", classifyResultText("{\"returnValue\":true}").isError === false);
	check("5.2 嵌套 JSON → 不误报", classifyResultText("{\"returnValue\":\"{\\\"intensity\\\":6}\"}").isError === false);
	check("5.3 空文本 → 不误报", classifyResultText("").isError === false);
	check("5.4 空白文本 → 不误报", classifyResultText("   ").isError === false);

	// 6. 无前缀 Parameter error / MCP error 兜底
	check("6.1 无前缀 Parameter error → validation_error", classifyResultText("Parameter error: x").errorType === "validation_error");
	check("6.2 无前缀 MCP error -32000 → server_error", classifyResultText("MCP error -32000: Connection closed").errorType === "server_error");

	console.log("\n" + "=".repeat(60));
	console.log(`结果: ${PASS} ${passed}  ${FAIL} ${failed}`);
	if (failed === 0) console.log("✅ S4 错误分类全部通过");
	console.log("=".repeat(60));
}

main();
