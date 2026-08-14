---
name: set-properties-param-convention
description: set_properties 只有 values (JSON 字符串) 一个通道，没有 properties 参数；set_actor_transform 参数名是 xform
metadata:
  type: gotcha
---

**2026-08-14 实机验证（UE MCP schema）修正**：此前记录的"常规组件用 properties object、PPV 用 values"是**错的**。当前 UE build 的 `set_properties` schema：

```json
{ "type": "object", "properties": { "instance": {...}, "values": {"type": "string"} }, "required": ["instance", "values"] }
```

**所有 set_properties 调用必须用 `values: JSON.stringify(props)`**：
- 常规组件（DirectionalLight 等）: `values: '{"intensity":6}'`（props 直接展开）
- PPV settings: `values: '{"settings": {...}}'`（settings 整体 struct，仍需 bOverride_* 标志）

**set_actor_transform**：参数名是 **`xform`**（不是 transform），ToolsetTransform = { location, rotation, scale }，rotation 字段为**小写** `pitch/yaw/roll`（get_actor_transform 返回同样小写）。

**Why**: 2026-08-14 实机 smoke test 发现旧写法（properties object / transform 参数）全部返回 server_error `input param "values"/"xform" is required`。apply.ts（008d 预设应用）与旧 applyRollback 因此从未在实机生效。

**How to apply**: 任何写 UE 的代码（set_properties / set_actor_transform）必须按此 schema；get_properties 仍用 `properties: [...]`（数组）读。参考 rollback.ts / apply.ts / assess-lighting.ts 的 resetPostProcessToDefaults。
