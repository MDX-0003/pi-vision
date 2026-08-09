---
name: mcp-calltool-three-params
description: MCP SDK callTool 有 3 个参数不是 2 个——options 在第三个位置，resultSchema 在第二个
metadata:
  type: gotcha
---

MCP SDK v1.x 的 `client.callTool()` 签名为 3 参数：

```typescript
callTool(params, resultSchema?, options?)
//       ~~~~~~  ~~~~~~~~~~~~~  ~~~~~~~~
//       ①       ②               ③
```

- ① `params: { name: string; arguments?: Record<string, unknown> }` — 工具调用参数
- ② `resultSchema?: ZodSchema` — 响应校验 schema（默认 `CallToolResultSchema`）
- ③ `options?: RequestOptions` — `{ signal?, timeout?, ... }`

**常见错误**：把 `{ signal }` 传入第二个参数位（`resultSchema` 位置），写成：

```typescript
// ❌ 错：{ signal } 被当成了 resultSchema
client.callTool({ name, arguments: args }, { signal: controller.signal })
```

**正确写法**：

```typescript
// ✅ 对：undefined 占位 + options 在第三位
client.callTool({ name, arguments: args }, undefined, { signal: controller.signal })
```

**Why:** 2026-08-09 因为这个参数错位，导致所有 UE 工具调用失败（`v3Schema.safeParse is not a function`）。详见 [[mcp-sdk-calltool-params-bug]]。

**How to apply:** 每次调用 `client.callTool()` 前，心里默数：params → resultSchema → options。只想传 options 时，第二个参数显式写 `undefined`。
