# Issue 010c — capturePresetState 独立测试 + 诊断脚本

**状态**: Draft  
**依赖**: 无（与 010a、010b 并行独立，但建议在 010a 和 010b 改动稳定后再跑诊断脚本）

---

## 动机

`capturePresetState` 是预设系统核心路径——决定了 `save_preset` 快照了什么。但：

1. **没有独立测试**：现有测试（`test/presets-008b-tools.mjs`）只测 schema 编译和 UE 断开时的错误返回
2. **5 处静默失败**：`find_actors` error / `resolveComponentRefPaths` 空 / `list_properties` error / `get_properties` error 全部 `continue` 跳过，不记录到 `missingActors`
3. **实际 session 中 5 类 actor 只捕获到 2 个**（SkyLight + VolumetricCloud），丢失了 DirectionalLight、SkyAtmosphere、ExponentialHeightFog，原因不明

**目标**：
- **(A) Mock 单元测试**：验证 whitelist 过滤、missingActor 追踪、错误分支、transform 获取。可 CI 跑，保回归。
- **(B) 诊断脚本**：直连 UE MCP，逐步骤打印 verbose 日志，定位当前为什么丢 actor。

---

## 一、Mock 单元测试

**文件**：`test/presets-010c-capture.test.ts`

### 测试结构

不 mock 依赖——mock 整个 `UeClient.callTool`，注入预设返回值序列，测试 `capturePresetState` 的纯逻辑。

### 测试用例

```
1. 空场景 (所有 find_actors 返回 [])
   → actors: {}, missingActors: ["DirectionalLight","SkyLight","SkyAtmosphere","ExponentialHeightFog","VolumetricCloud"]

2. 完整场景 (5 类 actor 全存在，所有属性可读)
   → actors 包含 5 个 key，每个有 components + refPath
   → DirectionalLight 有 transform.rotation
   → missingActors: []

3. find_actors 返回 error
   → 该类 actor 被跳过，不出现在 actors，也不出现在 missingActors ← 当前行为 bug？
   → 确认预期行为: isError 时也应记入 missingActors

4. resolveComponentRefPaths 返回空
   → 该类 actor 被跳过（现有行为），确认是否需要追踪

5. list_properties 返回 error
   → 同上

6. get_properties 返回 error
   → 同上

7. transform 获取失败 (DirectionalLight 无 transform)
   → actors[dirLight].transform === undefined，不阻断

8. 多个同类 actor (如 2 个 DirectionalLight)
   → actors 中两个 key 都存在，各自有 components
```

### UeClient mock 策略

```typescript
// 伪代码 — mock callTool 按 (toolName, params) 返回预设数据
function createMockUeClient(responses: CallToolResponse[]): UeClient {
  let callIndex = 0;
  return {
    isConnected: true,
    callTool: async (name: string, params: Record<string, unknown>) => {
      // 按调用顺序返回 callIndex++ 对应的 response
      // 或按 (name, glob/instance) 匹配
      return responses[callIndex++] ?? { isError: true, text: "unexpected call" };
    },
  } as unknown as UeClient;
}
```

### 关键验证点

| 验证点 | 方法 |
|------|------|
| whitelist filter 只提取 whitelist 中的属性 | 给 list_properties 返回多余属性，验证最终只存 whitelist 匹配到的 |
| componentClass 匹配 | 同一个 property 在不同 componentClass 上不同处理 |
| missingActors vs isError | 当前 isError 不记 missingActors → 确认是否需要修复 |
| DirectionalLight transform 提取 | 验证 rotation.Pitch/Yaw/Roll 的字段名容错（Pitch vs pitch） |

---

## 二、诊断脚本

**文件**：`test/presets-010c-capture-diag.ts`

### 执行方式

```bash
node --import tsx test/presets-010c-capture-diag.ts
```

### 输出格式

每一步打印 `[DIAG]` 前缀日志：

```
[DIAG] === capturePresetState diagnostic ===
[DIAG] Connected to UE MCP at http://localhost:8000/mcp

[DIAG] --- DirectionalLight ---
[DIAG]   find_actors("*DirectionalLight*") → OK, 1 actor(s)
[DIAG]     actorRefPath: /Game/Main.Main:PersistentLevel.DirectionalLight_0
[DIAG]   resolveComponentRefPaths(["directionalLightComponent"]) → OK
[DIAG]     compRefPath: /Game/Main.Main:PersistentLevel.DirectionalLight_0.directionalLightComponent
[DIAG]   list_properties → OK, 47 properties
[DIAG]   whitelist match: ["lightColor","intensity","atmosphereSunLightColor","temperature","lightSourceAngle","indirectLightingIntensity","volumetricScatteringIntensity"]
[DIAG]   get_properties([7 props]) → OK
[DIAG]     lightColor = {r:1,g:0.92,b:0.85,a:1}
[DIAG]     intensity = 10
[DIAG]     ...
[DIAG]   get_actor_transform → OK
[DIAG]     rotation: {Pitch:0,Yaw:-45,Roll:0}
[DIAG]   ✓ captured

[DIAG] --- SkyLight ---
[DIAG]   find_actors("*SkyLight*") → OK, 1 actor(s)
[DIAG]   ... (同上结构)

[DIAG] --- SkyAtmosphere ---
[DIAG]   find_actors("*SkyAtmosphere*") → ERROR: [timeout] request exceeded 60000ms
[DIAG]   ✗ skipped (find_actors error, not in missingActors)

[DIAG] --- ExponentialHeightFog ---
[DIAG]   find_actors("*ExponentialHeightFog*") → OK, 0 actor(s)
[DIAG]   ✗ missing

[DIAG] --- VolumetricCloud ---
[DIAG]   ...

[DIAG] === Summary ===
[DIAG] Captured: 2 actors
[DIAG]   - PersistentLevel.SkyLight_0
[DIAG]   - PersistentLevel.VolumetricCloud_0
[DIAG] Missing (find_actors returned []): [ExponentialHeightFog, SkyAtmosphere]
[DIAG] Skipped (find_actors error, NOT tracked): [DirectionalLight]
```

### 诊断目标

通过上述日志，直接定位：
1. **DirectionalLight** 的 `find_actors` 是成功返回 0 条、成功返回 1 条、还是报错？
2. 如果返回 1 条，**后续 resolveComponentRefPaths 是否拿到了 refPath**？
3. `list_properties` 返回的属性数量，**whitelist 匹配到了几个**？
4. `get_properties` 请求的具体属性名是否正确？

---

## 三、capturePresetState 的潜在 bug（诊断前预测）

基于代码审查，可能的原因：

| 可能原因 | 概率 | 诊断脚本如何验证 |
|------|:--:|------|
| `find_actors` glob 不匹配 (如实际 actor 名不含 `*DirectionalLight*`) | 中 | 打印 glob + 实际返回 actor 名 |
| `find_actors` 返回 error（超时等）→ 静默跳过 | 高 | 打印 `isError` 状态 |
| `resolveComponentRefPaths` 中 compKeys 名称不对（如 `directionalLightComponent` 实际是 `DirectionalLightComponent`） | 中 | 打印 get_properties 的完整返回 |
| `list_properties` 返回 error | 低 | 打印 isError |
| `get_properties` 尝试读不存在的属性名 → error | 低 | 打印请求的属性 + 返回 |

---

## 四、PRD §7.5 参考的 UE 工具名（诊断脚本需要）

```
find_actors:     toolset_registry.toolsets.core.scene.SceneTools.find_actors
list_properties: toolset_registry.toolsets.core.object.ObjectTools.list_properties
get_properties:  toolset_registry.toolsets.core.object.ObjectTools.get_properties
get_actor_transform: toolset_registry.toolsets.core.object.ObjectTools.get_actor_transform
```

---

## 涉及文件清单（汇总）

| 文件 | 操作 |
|------|------|
| `test/presets-010c-capture.test.ts` | 新建 — mock 单元测试（8 个用例） |
| `test/presets-010c-capture-diag.ts` | 新建 — UE MCP 诊断脚本 |
