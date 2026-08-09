---
name: ue-tool-name-sanitization
description: UE MCP 工具名含点号，LLM API 只允许 [a-zA-Z0-9_-]+，需要 PiToolRegistration 同时持有 sanitizedName 和 ueName
metadata:
  type: decision
---

UE MCP Server 暴露的工具全限定名包含点号分隔符，例如：

```
ToolsetRegistry.SceneTools.SceneTools.find_actors
```

但 Anthropic/OpenAI API 的 `function.name` 只匹配 `^[a-zA-Z0-9_-]+$`，不允许点号。

**决策**：`PiToolRegistration` 同时持有两个名字：

- `name: string` — 净化名（`sanitizeName()` 把 `.` → `_`），给 Pi registerTool 和 LLM
- `ueName: string` — UE 原始全限定名，给 `UeClient.callToolWithRetry()` 发送给 UE

净化函数位于 [schema-converter.ts](../../packages/ue-harness/src/ue-client/schema-converter.ts#L17-19)：

```typescript
function sanitizeName(ueName: string): string {
  return ueName.replace(/\./g, "_");
}
```

**Why:** 2026-08-09 发现工具注册成功但 LLM 调用时 API 返回 `Invalid tools[7].function.name: string does not match pattern`。如果不拆两个名字，改净化名会让 UE 收到的工具名不匹配。

**How to apply:** 新加任何涉及工具名的逻辑时，务必区分"对 LLM 暴露的名字"和"对 UE 发送的名字"。`convertTool()` 的 `registration` 对象已包含两个字段，直接使用即可。
