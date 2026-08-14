# Bug: set_properties 只有 values 通道，set_actor_transform 参数名是 xform

**日期**: 2026-08-14
**发现**: Issue 012 实机 smoke test（rollback-diag 直连 UE MCP）
**影响**: apply.ts（008d 预设应用）与旧 applyRollback 的写路径**从未在实机生效**

---

## 现象

`set_properties` 传 `properties` object → `server_error`：

```
Function "set_properties", input param "values" is required by the function input schema Json, but is missing
```

`set_actor_transform` 传 `transform` → `server_error`：

```
Function "set_actor_transform", input param "xform" is required by the function input schema Json, but is missing
```

## 根因

UE MCP ToolsetRegistry 的 schema 是**唯一事实来源**，PRD/memory 中的旧约定（"常规组件用 properties object"、"transform 参数"）没有经过实机验证：

```json
// set_properties（ObjectTools）
{ "properties": { "instance": {...}, "values": {"type":"string"} }, "required": ["instance","values"] }

// set_actor_transform（ActorTools）— 参数名 xform，ToolsetTransform
{ "properties": { "actor": {...}, "xform": {...} }, "required": ["actor","xform"] }
```

rotation 字段为**小写** `pitch/yaw/roll`（get_actor_transform 返回同样小写，from 值整体往返无需转换）。

## 正确写法（实机验证通过）

```typescript
// 常规组件
set_properties({ instance: { refPath }, values: JSON.stringify({ intensity: 6 }) })

// PPV settings struct
set_properties({ instance: { refPath }, values: JSON.stringify({ settings: modifiedSettings }) })

// actor transform
set_actor_transform({ actor: { refPath }, xform: tf })
```

## 修复

1. `src/workflow/rollback.ts`：properties/values 通道统一 `values` 写；transform 通道 `xform`
2. `src/presets/apply.ts`：`properties: props` → `values: JSON.stringify(props)`；`transform` → `xform`
3. `test/rollback-diag.ts`（诊断脚本）同步修正
4. 更新 memory: `set-properties-param-convention`（推翻旧约定）、`ppv-set-properties-struct`（values 是唯一通道）

## 经验

- 写 UE 的代码必须对照实机 `tools/list` 的 schema，不要依赖 PRD/记忆中的参数名
- 实机 smoke test 是写路径正确性的唯一裁判——本次发现 008d 的 apply 从未生效
