---
name: ue-mcp-tool-naming
description: UE MCP 工具注册名全小写 snake_case 含点号，不是 PascalCase；PRD 常写错，必须从生产代码验证
metadata:
  type: gotcha
---

UE MCP 的工具名全为 **snake_case 小写 + 点号分隔**，不是 PascalCase。

实际命名规范（基于 `toolset_registry.toolsets.core.<category>.<subcategory>.<ToolsetName>.<method>`）：

| 错误（PRD 常写） | 正确（生产代码） |
|---|---|
| `ToolsetRegistry.SceneTools.SceneTools.find_actors` | `toolset_registry.toolsets.core.scene.SceneTools.find_actors` |
| `ToolsetRegistry.SceneTools.SceneTools.set_properties` | `toolset_registry.toolsets.core.object.ObjectTools.set_properties` |

**Why**: UE MCP 的 ToolsetRegistry 在 `ModelContextProtocolToolsetRegistryAdapter.cpp` 中从 toolset schema JSON 的 `name` 字段动态注册工具名。schema 中定义的名称全为 snake_case，运行时不经过 PascalCase 转换。UE 引擎测试 `ModelContextProtocolToolNameTests.cpp:41` 明确列出了 `toolset_registry.toolsets.core.actor.ActorTools.get_label` 作为合法工具名示例。

**How to apply**: 写 PRD 或调用 MCP 工具前，从以下生产代码中验证工具名：
- `map-atmosphere.ts` — find_actors, get_properties, list_properties
- `apply.ts` — set_properties, set_actor_transform
- `capture.ts` — CaptureViewportImage
- 直接 `curl http://localhost:8000/mcp` 调用 `tools/list` 确认
