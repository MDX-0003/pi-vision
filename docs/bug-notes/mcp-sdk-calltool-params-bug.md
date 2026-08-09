# Bug: MCP SDK callTool 参数错位 → `v3Schema.safeParse is not a function`

**日期**：2026-08-09
**修复 Commit**：待提交
**影响**：所有 UE 工具调用均返回 `[validation_error] v3Schema.safeParse is not a function`
**严重度**：P0 — 阻断全部 UE MCP 通信

---

## 1. 症状

Pi 扩展连接 UE 成功后，LLM 调用任何 UE 工具（包括零参数的 `get_current_level`）都返回：

```
[validation_error] v3Schema.safeParse is not a function
```

完整堆栈：

```
TypeError: v3Schema.safeParse is not a function
    at safeParse (zod-compat.js:34:29)
    at protocol.js:696:41
    at Client._onresponse
```

但实际上 UE MCP Server 本身工作正常（直接调用 SDK 可通过），且 Zod 3.25 + MCP SDK 1.30.0 的组合本身兼容——**错误在我们自己的代码**。

## 2. 根因：`as any` 掩盖了参数位置错误

### 原始代码（Bug）

```typescript
// mcp-client.ts:171-174
//我们自定义的callTool函数里，需要调用mcp库的callTool函数

const result = await this.client.callTool({
  name,
  arguments: args,
} as Parameters<Client["callTool"]>[0], { signal: controller.signal } as any);

//await this.client.callTool({参数1}as{类型1},{参数2}as{类型2})
//问题出在第二个参数 as any
```

**语法解释**
as 是编译期声明，哪怕这个callTool的返回值不是xx类型，只要写明as xx，编译器就会将其视作as的目标类型，直到运行时才会报错。

```
class Client {
  async connect(transport: Transport): Promise<void>;
  async listTools(params: ListToolsRequest): Promise<ListToolsResult>;
  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: ZodSchema,
    options?: RequestOptions,
  ): Promise<CallToolResult>;
}
```

Parameters<...>将目标的元素拆装为元组，Parameters<>[0]即取结果的首个元素

被组装的对象Client["callTool"]是一个函数类型签名，看上文的函数签名可知，Client.callTool()的参数有：

(params: Params, schema?: Schema, opts?: Opts) 

Parameters<...>将他们组装为元组，得到：

[Params, Schema | undefined, Opts | undefined]  

再取[0]得到Params:{ name: string; arguments?: Record<string, unknown> }

回到自定义的callTool函数调用处，第一个as的意思只是把参数{name,arguments: args}视作{ name: string; arguments?: Record<string, unknown> }类型，属于对形状的一种约束

**调用链**
这个自定义callTool的调用链是：
```
//packages\ue-harness\src\index.ts
const result = await _ueClient.callToolWithRetry(toolName, params);

//packages\ue-harness\src\ue-client\mcp-client.ts
async callToolWithRetry(name: string, args: Record<string, unknown>): Promise<McpCallResult>

//这就是上文我们在讨论的函数，这里面出了bug
async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>
```
### MCP SDK 的真实签名

```typescript
// @modelcontextprotocol/sdk v1.30.0
class Client {
  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },  // ① 工具调用参数
    resultSchema = CallToolResultSchema,                              // ② 响应的 Zod 校验 schema
    options?: RequestOptions                                          // ③ 超时/signal 等选项
  ): Promise<CallToolResult>;
}
```

### 实际传参对照

| 参数位置 | SDK 期望 | 我们传了什么 | 正确？ |
|:---:|------|------|:--:|
| ① `params` | `{ name, arguments: args }` | `{ name, arguments: args }` | ✅ |
| ② `resultSchema` | Zod schema (如 `CallToolResultSchema`) | `{ signal: controller.signal }` | ❌ |
| ③ `options` | `undefined` (未传) | — | — |

**我们把 `{ signal: controller.signal }` 这个纯 JS 对象传进了 `resultSchema` 参数位。**

### 为什么 TypeScript 没拦住？

两个 `as` 强制类型转换：

```typescript
{ name, arguments: args } as Parameters<Client["callTool"]>[0]  // 不必要但无碍
{ signal: controller.signal } as any                             // ← 关键！any 绕过了所有检查
```

`as any` 告诉 TypeScript "这个对象可以是任何类型"，从而把 `{ signal }` 塞进了 `resultSchema` 位置，TS 不报错。

### 为什么报错是 `v3Schema.safeParse is not a function`？

MCP SDK 收到 UE 响应后，用 `resultSchema` 校验响应格式（`protocol.js:696`）：

```typescript
// 实际执行（简化）：
safeParse(resultSchema, response.result);
//       ↑ 这里 resultSchema = { signal: controller.signal }  ← 一个普通对象！
```

```typescript
// zod-compat.js — safeParse 内部
function safeParse(schema, data) {
  if (isZ4Schema(schema)) {             // { signal: ... } 上没有 _zod 属性 → false
    return z4mini.safeParse(schema, data);
  }
  const v3Schema = schema;               // v3Schema = { signal: ... }
  const result = v3Schema.safeParse(data); // 💥 { signal: ... } 是普通对象，没有 .safeParse() 方法
  return result;
}
```

### 修复

```typescript
// 正确写法：3 个参数各归其位
const result = await this.client.callTool(
  { name, arguments: args },    // ① params
  undefined,                     // ② resultSchema: undefined → 用默认的 CallToolResultSchema
  { signal: controller.signal } // ③ options
);
```

## 3. 背景知识

### 3.1 Zod 是什么？

[Zod](https://zod.dev) 是 TypeScript 生态的运行时 schema 校验库，等价于 Python 的 Pydantic：

```typescript
import { z } from "zod";

// 定义 schema
const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
});

// 运行时校验
UserSchema.parse({ name: "Alice", age: "30" });     // 抛 ZodError（age 不是 number）
UserSchema.safeParse({ name: "Alice", age: "30" }); // 返回 { success: false, error: ... }
```

### 3.2 MCP SDK 为什么需要 Zod？

MCP 协议规定了严格的 JSON-RPC 消息格式。SDK 每次收到服务端响应后，用 Zod schema 校验结构是否正确：

```
客户端发送: tools/call { name: "find_actors", arguments: { glob: "*Light*", tag: "" } }
                ↓
UE 返回:     { content: [{ type: "text", text: "..." }] }
                ↓
SDK 用 CallToolResultSchema 校验这个响应对象 → 通过 → 返回给调用者
```

如果响应格式不符合协议规范（比如 UE 返回了非标准格式的数据），SDK 在校验阶段就能发现并报结构化错误，而不是让调用者自己 parse 裸 JSON。

### 3.3 Zod v3/v4 兼容层

MCP SDK 1.30.0 同时支持 Zod v3 和 v4：

```typescript
// zod-compat.js 的职责
import * as z3rt from 'zod/v3';       // Zod v3 运行时
import * as z4mini from 'zod/v4-mini'; // Zod v4 最小运行时

function isZ4Schema(s) {
  return !!s._zod;  // v4 schema 上有 _zod 标记位，v3 没有
}

function safeParse(schema, data) {
  if (isZ4Schema(schema)) {
    return z4mini.safeParse(schema, data); // v4: 模块级静态函数
  }
  // v3 路径
  const v3Schema = schema;
  return v3Schema.safeParse(data);         // v3: schema 实例方法（两个版本都有）
}
```

Zod v3 和 v4 的 schema 对象都内置了 `.safeParse()` 实例方法，所以兼容层代码本身是正确的。只有传入非 Zod 对象（如我们的 `{ signal }`）时才会报错。

## 4. 教训

| 教训 | 说明 |
|------|------|
| **禁止 `as any`** | 宁可花时间搞清楚真实类型签名，也绝不用 `as any` 强行压制类型错误 |
| **读 SDK 源码至少看签名** | `client.callTool` 的 3 参数签名在 `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:479` 一眼可见 |
| **最小复现原则** | 遇到 SDK 内部报错，先用纯 Node 脚本直接调 SDK 排除外部因素（本次用 `node --import tsx -e "..." ` 验证了 SDK 本身正常） |
| **`undefined` 是好习惯** | 只想用默认值的参数位，显式传 `undefined` 比跳过它更安全（如 `callTool(params, undefined, opts)`） |

## 5. 补充：Zod 的 `safeParse` 实例方法 vs 静态函数

这是一个常见混淆点，但与本次 bug 无关（因为我们传入的根本不是 Zod schema）：

| | Zod v3 | Zod v4 |
|------|------|------|
| 创建 schema | `z.string()` | `z.string()` |
| 实例方法 | `schema.parse()`, `schema.safeParse()` ✅ | `schema.parse()`, `schema.safeParse()` ✅ |
| 静态/模块级 | 无顶层 `z.safeParse()` | `z4mini.safeParse(schema, data)` ✅ |

两个版本在 schema **实例**上都提供了 `.safeParse()`，MCP SDK 的兼容层利用这一点做运行时检测。本次错误的唯一原因是传入了一个非 Zod 的普通对象。
