# CLAUDE.md — UE Harness Pi Extension

**本文件受众**：在 pi monorepo 中开发 `packages/ue-harness/` 的 AI agent。
**全局规则**：[AGENTS.md](AGENTS.md)（代码质量、命令、Git、发布等，对本文件中的约定有更高优先级）。

---

## 1. 项目定位

`packages/ue-harness/` 是一个 **Pi Agent 扩展**，在 LLM 与 Unreal Engine 5 MCP Server 之间架桥：

```
LLM (Pi) ←→ ue-harness extension ←→ UE MCP Server (:8000)
              ↑ TypeScript, 同进程
             tool_call block + before_agent_start 注入 + 结构化工具
```

它替代了 Python 版 UE Agent Harness（MCP Server 在 :9000 的提示词注入 + 只读拦截器方案），用 Pi 扩展的事件系统获得**硬控制力**（阻止工具调用、修改结果、替换 system prompt）。

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 扩展入口：`session_start` 连接 UE + 注册工具，`session_shutdown` 断开 |
| `src/ue-client/mcp-client.ts` | `UeClient` 类：MCP 连接管理、工具发现、工具调用、错误分类、自动重连 |
| `src/ue-client/schema-converter.ts` | JSON Schema（UE）→ TypeBox schema（Pi）自动转换 |
| `src/ue-client/types.ts` | 共享类型：`UeToolDefinition`, `McpCallResult`, `PiToolRegistration`, `UeHarnessConfig` |

---

## 2. 当前开发状态

| Issue | 描述 | 状态 |
|:---:|------|:--:|
| 001 | UE MCP 连通性验证（Spike） | ✅ 已完成 |
| 002 | MCP Bridge — 动态工具注册 + 扩展骨架 | ✅ 已完成 |
| 003 | Vision 管线 — `assess_lighting` | ⬜ 下一个 |
| 004 | 场景发现 + 快速验证 — `map_atmosphere` + `check_dimension` | ⬜ 待定 |
| 005 | 工作流编排 — Phase 状态机 + Tier 门控 | ⬜ 待定 |
| 006 | 打磨 — Skills 迁移 + 文档 + 可观测性 | ⬜ 待定 |

**完整 PRD**：[docs/ue-harness-extension-prd.md](docs/ue-harness-extension-prd.md)
**最近 handoff**：[docs/handoff/0809.md](docs/handoff/0809.md)

---

## 3. 架构决策

### 3.1 工具注册两层命名

UE 工具名含点号（如 `ToolsetRegistry.SceneTools.SceneTools.find_actors`），LLM API 只允许 `[a-zA-Z0-9_-]+`。解决方案：

- `PiToolRegistration.name`：净化名（点号→下划线），给 Pi/LLM 使用
- `PiToolRegistration.ueName`：UE 原始名（含点号），给 `UeClient.callTool()` 使用

### 3.2 MCP 连接为 session 级单例

扩展在 `session_start` 时创建 `UeClient`，`session_shutdown` 时断开。生命周期不跨 session。

### 3.3 自研工具 vs UE 透传工具

- **UE 透传工具**（218 个）：`session_start` 时通过 `listAllTools()` → `convertTool()` → `pi.registerTool()` 批量注册，执行时调用 `_ueClient.callToolWithRetry(ueName, params)`
- **自研工具**（3 个占位）：`map_atmosphere`, `assess_lighting`, `check_dimension`，硬编码占位返回，等 Issue 003/004 实现

### 3.4 工具排除白名单

`schema-converter.ts` 的 `EXCLUDED_PATTERNS` 排除 `*CaptureEditorImage`（依赖 DWM，窗口后台即失败）。所有截图统一用 `ViewportCaptureToolset.*.CaptureViewportImage`。

---

## 4. 开发环境

### 4.1 运行扩展

```bash
cd /d/Programs/2024-2/pi
node packages/coding-agent/dist/cli.js
```

扩展通过 `.pi/extensions/ue-harness.ts`（桥接文件）被 auto-discover，指向 `packages/ue-harness/src/index.ts`。jiti 即时编译，**每次重启 Pi 自动加载最新代码**。

### 4.2 环境变量

| 变量 | 默认值 | 用途 |
|------|------|------|
| `UE_MCP_URL` | `http://localhost:8000/mcp` | UE MCP Server 地址 |
| `VISION_API_KEY` | — | Vision 模型 API key（Issue 003 起需要） |
| `VISION_API_BASE_URL` | — | Vision API 端点 |
| `VISION_MODEL_ID` | `claude-sonnet-5-20251001` | Vision 模型 ID |
| `UE_MCP_TIMEOUT_MS` | `60000` | 工具调用超时毫秒 |
| `UE_MCP_RECONNECT_MAX` | `3` | 最大重连次数 |

### 4.3 测试

```bash
# Schema 转换器单元测试
node --experimental-vm-modules packages/ue-harness/test/verify-converter.mjs

# TypeBox schema 编译验证
node --import tsx packages/ue-harness/test/compile-schemas.ts
```

### 4.4 Pi API key 配置

`~/.pi/agent/auth.json`（与扩展代码无关，但运行 Pi 时需要）：

```json
{ "anthropic": { "type": "api_key", "key": "sk-ant-api03-..." } }
```

---

## 5. 代码约定

### 5.1 AGENTS.md 中与本扩展最相关的规则

- **禁止 `as any`**（AGENTS.md: "No any unless absolutely necessary"）— MCP SDK bug 的直接教训
- **读 node_modules 源码验证 API 签名**，不要用 `as` 凑— `client.callTool` 的 3 参数签名在 `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:479`
- **禁止 inline import**（AGENTS.md: "No inline imports"）— `await import()` 和动态类型导入都不允许

### 5.2 本扩展特有约定

- **工具名净化使用 `sanitizeName()`**，不手工改名字符串
- **自研工具 execute() 函数签名**：`(_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal) => Promise<AgentToolResult>`
- **UE 工具参数以 `Record<string, unknown>` 透传**，不在扩展层做参数校验（Pi 做第一次 TypeBox 校验，UE 做第二次，扩展层只负责转发）
- **错误消息用 `[ue-harness]` 前缀**，方便在 Pi 日志中过滤
- **Schema 转换失败不阻断注册**：`convertTool()` 返回 `null` 时标记为 excluded，继续处理下一个工具

---

## 6. 文档索引

| 文档 | 路径 |
|------|------|
| 完整 PRD | [docs/ue-harness-extension-prd.md](docs/ue-harness-extension-prd.md) |
| 最近 Handoff | [docs/handoff/0809.md](docs/handoff/0809.md) |
| Bug 记录 | [docs/bug-notes/](docs/bug-notes/) |
| AGENTS.md（全局规则） | [AGENTS.md](AGENTS.md) |

---

## 7. CLAUDE.md 与 Memory 的边界

| | CLAUDE.md（本文件） | `.claude/memory/` |
|------|------|------|
| **粒度** | 项目级——架构、约定、现状 | 原子事实——一个决策、一个 bug、一个 gotcha |
| **更新时机** | 架构变更、Issue 进展、新约定 | 每当发现一个值得跨 session 记住的事实 |
| **加载** | 每次新 session 完整加载 | 按需通过 `surface_memories` 召回 |
| **内容类型** | 上下文、规则 | 决策、错误教训、不变量、约束 |
| **示例** | "工具注册使用两层命名" | "2026-08-09: callTool 的 `as any` 导致参数错位"（详见 bug notes） |

**CLAUDE.md** = 这本项目的"地图"——agent 每次开工先看它。
**memory/** = "便利贴墙"——小而独立的知识点，可以随时增删而不改架构文档。

### 写 Memory 的规范

每个 memory 文件 = 一个事实，存放在 `.claude/memory/`，格式：

```markdown
---
name: <kebab-slug>
description: <一句话摘要——用于 surface_memories 召回匹配>
metadata:
  type: decision | bug | gotcha | constraint | invariant
---

<事实内容>

**Why:** <为什么成立>
**How to apply:** <在什么场景下要想起它>
```

Memory 示例：
- `as-any-ban.md` — "禁止 as any" 这条约束及其来源
- `calltool-three-params.md` — MCP SDK callTool 的 3 参数陷阱
- `ue-tool-naming.md` — UE 工具名含点号需要净化的原因

---

## 8. 已知问题与教训

| 日期 | 问题 | 文档 |
|------|------|------|
| 2026-08-09 | `as any` 把 `{ signal }` 偷渡进 `callTool` 的 `resultSchema` 参数位，导致所有工具调用失败 | [docs/bug-notes/mcp-sdk-calltool-params-bug.md](docs/bug-notes/mcp-sdk-calltool-params-bug.md) |

**这是教训区的起点。** 后续发现任何 bug 或踩坑经验，按 §7 的规范同时更新：
1. 在 `docs/bug-notes/` 写完整 bug 报告
2. 在 `.claude/memory/` 写一个简短的 fact file
3. 在本节加一行索引
