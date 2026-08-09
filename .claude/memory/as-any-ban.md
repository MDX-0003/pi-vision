---
name: as-any-ban
description: 绝对禁止 as any——它会压制 TypeScript 类型错误，导致运行时 bug 难以追踪
metadata:
  type: constraint
---

**约束**：在本扩展代码中绝对不使用 `as any`。

这是 AGENTS.md "No any unless absolutely necessary" 规则的具体强化版——在本扩展中，`as any` 已经从"不建议"升级为"禁止"。

**Why:** 2026-08-09 发现的 MCP SDK callTool bug 的直接根因就是 `as any`。`{ signal: controller.signal } as any` 把一个 options 对象静默塞进了 `resultSchema` 参数位，TypeScript 完全没报错，导致所有 UE 工具调用失败，排查耗时远超如果不写 `as any` 的编译时间。

**How to apply:** 写任何函数调用时，如果 TypeScript 报类型不匹配，**不要加 `as` 绕过去**。去读 SDK 源码核实真实签名（`node_modules/` 里直接看 `.js` 或 `.d.ts`），然后传正确的参数。
