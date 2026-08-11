# Issue 008d — 加载路径：属性应用 + load_preset 工具

**状态**: 待开工
**依赖**: Issue 008a（`loadPresetEntry()`, `PresetEntry`, `PresetActor`）+ 008c（`_activeReferencePath` getter/setter）
**预计**: 1.5 天
**PRD**: [docs/issue-008-preset-system.md](../../issue-008-preset-system.md)

---

## 1. 目标

实现预设的**加载路径**：LLM 调 `load_preset(name)` → 读 JSON → 批量 `set_actor_transform` + `set_properties` → 更新 `_activeReferencePath` → 返回应用摘要。

---

## 2. 依赖

- 008a 产出：`loadPresetEntry()`, `PresetEntry`, `PresetActor`, `getPresetDir()`
- 008c 产出：`setActiveReferencePath()` in `state.ts`
- 已有 `getUeClient()` in `state.ts`
- 已有 `UeClient.callTool()` 模式

---

## 3. 产出文件

| 文件 | 操作 | 内容 |
|------|:--:|------|
| `packages/ue-harness/src/presets/apply.ts` | N | `applyPreset()` — 批量设置场景属性 |
| `packages/ue-harness/src/presets/tools.ts` | E | 新增 `loadPresetDef` + `executeLoadPreset` |
| `packages/ue-harness/src/index.ts` | E | `registerSelfTools()` 注册 `load_preset` |

---

## 4. 详细规格

### 4.1 `presets/apply.ts` — 属性应用

```typescript
/**
 * Issue 008d — 预设属性应用
 *
 * 将预设的 components 属性批量设置到 UE 场景中。
 * 第一阶段：DirectionalLight transform（旋转）
 * 第二阶段：各组件属性（set_properties）
 * 第三阶段：PostProcessVolume 重置（如果 postprocessReset）
 */

import type { UeClient } from "../ue-client/mcp-client.ts";
import type { PresetEntry } from "./types.ts";

export interface ApplyResult {
  name: string;
  applied: Record<string, number>;  // actor → 设置的属性数
  skipped: Record<string, string>;  // actor → 跳过原因
  resetPostprocess: boolean;
}

/**
 * 将预设应用到当前 UE 场景。
 * 单线程顺序执行（与 MCP Server 通信串行处理）。
 */
export async function applyPreset(
  ueClient: UeClient,
  entry: PresetEntry,
): Promise<ApplyResult> {
  const setTransformName = "toolset_registry.toolsets.core.object.ObjectTools.set_actor_transform";
  const setPropsName = "toolset_registry.toolsets.core.object.ObjectTools.set_properties";

  const applied: Record<string, number> = {};
  const skipped: Record<string, string> = {};

  for (const [actorKey, actor] of Object.entries(entry.actors)) {
    try {
      // 第一阶段: DirectionalLight 旋转
      if (actor.transform) {
        await ueClient.callTool(setTransformName, {
          instance: { refPath: actor.refPath },
          transform: actor.transform,
        });
      }

      // 第二阶段: 批量属性
      for (const [_compKey, props] of Object.entries(actor.components)) {
        const propCount = Object.keys(props).length;
        if (propCount === 0) continue;

        // UE MCP set_properties 接受 { instance, properties } 格式
        const result = await ueClient.callTool(setPropsName, {
          instance: { refPath: actor.refPath },
          properties: props,
        });

        if (result.isError) {
          skipped[actorKey] = `set_properties failed: ${result.text.substring(0, 100)}`;
        } else {
          applied[actorKey] = (applied[actorKey] || 0) + propCount;
        }
      }
    } catch (e) {
      skipped[actorKey] = `actor not found or error: ${(e as Error).message}`;
    }
  }

  // 第三阶段: PostProcessVolume 重置
  // 如果 postprocessReset = true，将 PostProcessVolume 的 color grading 参数回退到默认值
  // 实现细节：find PostProcessVolume actor → set_properties(默认值)

  return {
    name: entry.name,
    applied,
    skipped,
    resetPostprocess: entry.postprocessReset,
  };
}
```

### 4.2 `presets/tools.ts` — 新增 load_preset

```typescript
import { join } from "path";
import { getUeClient } from "../state.ts";
import { setActiveReferencePath } from "../state.ts";
import { loadPresetEntry, getPresetDir } from "./store.ts";
import { applyPreset } from "./apply.ts";

// ═══════════════════════════════════════════
// load_preset
// ═══════════════════════════════════════════

export const loadPresetDef = {
  name: "load_preset",
  label: "Load Preset",
  description:
    "加载指定预设到当前场景。批量设置 DirectionalLight/SkyLight/SkyAtmosphere/" +
    "ExponentialHeightFog/VolumetricCloud 的属性。加载后 _activeReferencePath 自动指向预设截图。" +
    "不自动触发——LLM 需要根据 before_agent_start 匹配建议主动调用。",
  parameters: Type.Object({
    name: Type.String(),
  }),
  promptSnippet: 'load_preset("name"): 批量应用预设，快速还原调参结果',
  promptGuidelines: [
    "仅在 before_agent_start 匹配建议中看到合适的预设时才调用",
    "加载后调 assess_lighting() 检验预设效果（此时 reference_path 自动指向预设截图）",
    "如果用户想加载但不满意，可以继续手动调参——加载只是设置起点",
  ],
};

async function executeLoadPreset(params: { name: string }): Promise<AgentToolResult> {
  const ueClient = getUeClient();
  if (!ueClient?.isConnected) return errResult("UE MCP not connected");

  const entry = loadPresetEntry(params.name);
  if (!entry) return errResult(`预设 '${params.name}' 不存在或已损坏`);

  const result = await applyPreset(ueClient, entry);

  // 更新活跃参考路径：指向预设截图
  const presetDir = getPresetDir(params.name);
  const screenshotPath = join(presetDir, entry.screenshot);
  setActiveReferencePath(screenshotPath);

  return {
    content: [{ type: "text", text: JSON.stringify({
      loaded: true,
      name: params.name,
      referenceImage: `${entry.screenshot}（已切换为此预设的截图，assess_lighting 将自动与此截图对比）`,
      applied: result.applied,
      skipped: Object.keys(result.skipped).length > 0 ? result.skipped : undefined,
      resetPostprocess: result.resetPostprocess,
    }) }],
  };
}
```

### 4.3 `index.ts` 编辑 — 注册 load_preset

在 `registerSelfTools()` 中追加：

```typescript
import { loadPresetDef, executeLoadPreset } from "./presets/tools.ts";

pi.registerTool({
  name: loadPresetDef.name,
  label: loadPresetDef.label,
  description: loadPresetDef.description,
  parameters: loadPresetDef.parameters,
  promptSnippet: loadPresetDef.promptSnippet,
  promptGuidelines: loadPresetDef.promptGuidelines,
  execute: (_id: string, params: { name: string }) => executeLoadPreset(params),
});
```

---

## 4. 快照范围参考（与 PRD §4.1 一致）

| 组件类型 | 应用的属性 |
|------|------|
| DirectionalLight | LightColor, Intensity, Temperature, LightSourceAngle + transform(rotation) |
| SkyLight | LightColor, Intensity |
| SkyAtmosphere | MieScatteringScale, MieScattering, MieExponentialDistribution, RayleighScatteringScale |
| ExponentialHeightFog | FogDensity, FogHeightFalloff, FogInscatteringLuminance, DirectionalInscatteringExponent |
| VolumetricCloud | LayerBottomAltitude, LayerHeight, bVisible |

---

## 5. 边界条件

| 场景 | 处理 |
|------|------|
| 预设中某 actor 在当前场景中不存在 | `applyPreset` 捕获错误 → `skipped[actorKey]`，继续其他 actor |
| set_properties 部分属性失败 | 只要 `callTool` 不抛异常，按成功计数。MCP Server 内部的属性级错误通过 `result.isError` 检测 |
| 预设文件 JSON 损坏 | `loadPresetEntry()` 返回 `null` → load_preset 返回错误 |
| load_preset 后参考图（预设截图）不存在 | 不影响加载——`_activeReferencePath` 指向路径，但 `assess_lighting()` 会检测文件不存在并报错 |
| 大预设（>20 组件） | 不做分批——`for` 循环串行，UE MCP Server 处理 |

---

## 6. 独立测试

### 6.1 可测项

| 函数 | 可测性 | 测试方式 |
|------|:--:|------|
| `applyPreset()` | ❌ | 依赖 UE MCP（`callTool` 需要运行中的 UE 实例） |
| `executeLoadPreset()` | ⚠️ | 可测未连接错误分支 + 预设不存在分支 |

### 6.2 可间接验证的点

测试文件：`packages/ue-harness/test/presets-tools.test.ts`（追加）

```typescript
// Case 1: load_preset 不存在预设 → 返回错误
//   模拟 getUeClient().isConnected === true
//   传入不存在的 preset name
//   executeLoadPreset({ name: "nonexistent" })
//     → { isError: true, content: [{ text: "..." }] }
//     错误消息包含 "不存在"

// Case 2: load_preset UE 未连接 → 返回错误
//   模拟 getUeClient() 返回 null
//   executeLoadPreset({ name: "any" })
//     → { isError: true }
//     错误消息包含 "not connected"

// Case 3: loadPresetDef 的 TypeBox schema 编译正确
//   Type.Strict(loadPresetDef.parameters) → 不抛异常
//   接受 { name: "valid-name" }，拒绝 { name: 123 }
```

### 6.3 跳过项

| 函数/逻辑 | 原因 |
|------|------|
| `applyPreset()` 批量属性设置 | 依赖 UE MCP 的 `callTool()` — 需真实 UE 场景，008e 集成测试覆盖 |
| `_activeReferencePath` 更新 | 简单 `setActiveReferencePath()` 调用，无复杂逻辑 |
| PostProcessVolume 重置 | 依赖 UE MCP，与 `applyPreset` 同属集成测试范畴 |

---

## 7. 验收标准

1. 保存一个预设后，重置场景 → `load_preset("test-preset")` → DirectionalLight 旋转 + 各组件属性被设置
2. `_activeReferencePath` 指向 `~/.pi/agent/presets/test-preset/test-preset.png`
3. 之后调 `assess_lighting()`（不传 `reference_path`）→ 自动用预设截图作为参考图
4. 加载不存在的预设名 → 返回 `{ loaded: false, error: "..." }`
5. 预设截图缺失时 `load_preset` 仍成功（`assess_lighting` 时才报错）

---

## 8. 与后续 Issue 的接口

| 元素 | 后续使用者 |
|------|------|
| `applyPreset()` | 仅 008d |
| `ApplyResult` | 仅 008d |
| `load_preset` 工具 | 008e（集成测试） |
