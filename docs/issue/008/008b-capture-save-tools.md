# Issue 008b — 保存路径：场景快照 + save/list/delete 工具

**状态**: 待开工
**依赖**: Issue 008a 完成（`analyzeAndTag()`, `PresetTags`, `PresetEntry`, `PresetActor`, store 函数）
**预计**: 1.5 天
**PRD**: [docs/issue-008-preset-system.md](../../issue-008-preset-system.md)

---

## 1. 目标

实现预设的**写入路径**：LLM 调 `save_preset(name)` → 截当前视口 → Vision 生成标签 → 快照场景组件属性 → 写磁盘。同时注册 `list_presets` 和 `delete_preset`。

---

## 2. 依赖

- 008a 产出：`analyzeAndTag()`, `PresetTags`, `PresetEntry`, `PresetActor`, `savePresetEntry()`, `loadAllPresets()`, `deletePresetDir()`, `presetExists()`, `getPresetDir()`
- 已有 `captureViewport()` in `vision/capture.ts`
- 已有 `getUeClient()` in `state.ts`
- 已有 `getVisionClient()` in `state.ts`
- 已有工具注册模式 in `index.ts`（`pi.registerTool({...})`）

---

## 3. 产出文件

| 文件 | 操作 | 内容 |
|------|:--:|------|
| `packages/ue-harness/src/presets/capture.ts` | N | `capturePresetState()` — 快照场景中 5 类氛围组件 |
| `packages/ue-harness/src/presets/tools.ts` | N | `savePresetToolDef`, `listPresetsToolDef`, `deletePresetToolDef` |
| `packages/ue-harness/src/index.ts` | E | `registerSelfTools()` 中注册 3 个工具 |

---

## 4. 详细规格

### 4.1 `presets/capture.ts` — 场景快照

```typescript
/**
 * Issue 008b — 预设场景快照
 *
 * 调用 UE MCP 工具获取 5 类氛围组件当前属性。
 * 返回与 PresetEntry.actors 兼容的结构。
 */

import type { UeClient } from "../ue-client/mcp-client.ts";
import type { PresetActor } from "./types.ts";

// 参考已有 map-atmosphere.ts 的模式
// 复用 ATMOSPHERE_COMPONENT_GLOBS 的定义（无需重复声明）

export interface CaptureResult {
  actors: Record<string, PresetActor>;
  missingActors: string[];
}

/**
 * 快照当前场景中 5 类氛围组件的属性。
 * 实现参考 map-atmosphere.ts 的 executeMapAtmosphere() 逻辑，
 * 但只提取 whitelist 中的属性值（不生成 Tier 结构）。
 */
export async function capturePresetState(ueClient: UeClient): Promise<CaptureResult> {
  // 组件类别：与 map-atmosphere.ts 的 ATMOSPHERE_COMPONENT_GLOBS 一致
  // DirectionalLight, SkyLight, SkyAtmosphere, ExponentialHeightFog, VolumetricCloud
  // 每类: find_actors → get_properties(获取组件refPath) → list_properties → get_properties(读取属性值)
  // 只保存 whitelist 中的属性（复用 ATMOSPHERE_WHITELIST）
  // PostProcessVolume 不保存属性——仅标记 postprocessReset

  // 伪代码结构：
  // for each component type:
  //   find_actors(glob)
  //   对找到的 actor: get_actor_transform(DirectionalLight) / get_properties(component+whitelist)
  //   组装 PresetActor
  // 返回 { actors: {...}, missingActors: [...] }
}
```

**实现要点**：
- 复用 `map-atmosphere.ts` 中已有的 `ATMOSPHERE_WHITELIST` 和 `ATMOSPHERE_COMPONENT_GLOBS`
- 每个 actor 的 refPath 格式：`/Game/Main.Main:PersistentLevel.DirectionalLight_0`
- DirectionalLight 需要额外调用 `get_actor_transform` 获取 rotation
- PostProcessVolume 跳过（不存属性，只在外层标记 `postprocessReset: true`）
- 参考 `map-atmosphere.ts` 的 `parseUeReturnValue()` 和 `extractActorRefPaths()` 辅助函数——考虑提取到公共模块避免重复

### 4.2 `presets/tools.ts` — 工具定义

```typescript
/**
 * Issue 008b — 预设工具定义（save/list/delete）
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { getUeClient, getVisionClient } from "../state.ts";
import { captureViewport } from "../vision/capture.ts";
import { analyzeAndTag } from "../vision/analyzer.ts";
import { capturePresetState } from "./capture.ts";
import {
  loadAllPresets, savePresetEntry, deletePresetDir, presetExists, getPresetDir,
} from "./store.ts";
import type { PresetEntry } from "./types.ts";

// ═══════════════════════════════════════════
// save_preset
// ═══════════════════════════════════════════

export const savePresetDef = {
  name: "save_preset",
  label: "Save Preset",
  description:
    "将当前场景的光照参数保存为预设。自动截取当前视口、生成氛围标签、快照组件属性。" +
    "同名预设存在时返回错误——需先调 delete_preset 再保存。",
  parameters: Type.Object({
    name: Type.String(),
  }),
  promptSnippet: 'save_preset("name"): 将当前场景保存为预设，下次可 load_preset 快速加载',
  promptGuidelines: [
    "仅在用户明确确认满意后调用",
    "预设名用 kebab-case（如 golden-hour-ocean）",
    "同名预设存在时会报错——先确认用户是否要覆盖,然后 delete_preset + save_preset",
  ],
};

async function executeSavePreset(params: { name: string }): Promise<AgentToolResult> {
  const ueClient = getUeClient();
  const vision = getVisionClient();

  if (!ueClient?.isConnected) return errResult("UE MCP not connected");
  if (!vision?.isConfigured) return errResult("Vision API not configured");

  // 1. 同名检测
  if (presetExists(params.name)) {
    const existing = `（检查 ~/.pi/agent/presets/${params.name}/preset.json 获取 created 时间）`;
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: false,
        error: `预设 '${params.name}' 已存在。如需覆盖，请先向用户确认，然后调 delete_preset('${params.name}') 后再调 save_preset。`,
      }) }],
    };
  }

  // 2. 截图
  const capture = await captureViewport(ueClient, 1.0);
  if (!capture) return errResult("Viewport capture failed");

  // 3. Vision 标签分析
  let tagResult;
  try {
    tagResult = await analyzeAndTag(vision, capture.base64);
  } catch (e) {
    return errResult(`Vision tagging failed: ${(e as Error).message}`);
  }

  // 4. 场景快照
  const scene = await capturePresetState(ueClient);

  // 5. 组装 PresetEntry
  const entry: PresetEntry = {
    name: params.name,
    description: tagResult.description,
    tags: tagResult.tags,
    freeformTags: tagResult.freeformTags,
    screenshot: `${params.name}.png`,
    actors: scene.actors,
    postprocessReset: true,
    created: new Date().toISOString(),
  };

  // 6. 拷贝截图到预设目录
  savePresetEntry(entry);
  const presetDir = getPresetDir(params.name);
  // 如果目录还不存在: mkdirSync(presetDir, { recursive: true });
  copyFileSync(capture.filePath, join(presetDir, `${params.name}.png`));

  return {
    content: [{ type: "text", text: JSON.stringify({
      success: true,
      name: params.name,
      tags: tagResult.tags,
      freeformTags: tagResult.freeformTags,
      actorCount: Object.keys(scene.actors).length,
      missingActors: scene.missingActors.length > 0 ? scene.missingActors : undefined,
      validation: tagResult.validation,
    }) }],
  };
}

// ═══════════════════════════════════════════
// list_presets
// ═══════════════════════════════════════════

export const listPresetsDef = {
  name: "list_presets",
  label: "List Presets",
  description: "列出所有已保存的预设（名称、标签、描述、创建时间）",
  parameters: Type.Object({}),
  promptSnippet: "list_presets(): 列出所有已保存的预设",
  promptGuidelines: ["在决定是否加载预设前，先调此工具查看可选列表"],
};

async function executeListPresets(): Promise<AgentToolResult> {
  const presets = loadAllPresets();
  const summary = presets.map(p => ({
    name: p.name,
    description: p.description,
    tags: p.tags,
    freeformTags: p.freeformTags,
    created: p.created,
    screenshot: p.screenshot,
  }));

  return {
    content: [{ type: "text", text: JSON.stringify({ presets: summary, count: summary.length }) }],
  };
}

// ═══════════════════════════════════════════
// delete_preset
// ═══════════════════════════════════════════

export const deletePresetDef = {
  name: "delete_preset",
  label: "Delete Preset",
  description: "删除指定预设（包括其截图文件）。不可恢复。",
  parameters: Type.Object({
    name: Type.String(),
  }),
  promptSnippet: 'delete_preset("name"): 删除指定预设',
  promptGuidelines: ["删除前向用户确认"],
};

async function executeDeletePreset(params: { name: string }): Promise<AgentToolResult> {
  if (!presetExists(params.name)) {
    return errResult(`预设 '${params.name}' 不存在`);
  }
  deletePresetDir(params.name);
  return {
    content: [{ type: "text", text: JSON.stringify({ deleted: true, name: params.name }) }],
  };
}

// ═══════════════════════════════════════════
// helper
// ═══════════════════════════════════════════

function errResult(msg: string): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }) }],
    isError: true,
  };
}
```

### 4.3 `index.ts` 编辑 — 注册 3 个工具

在 `registerSelfTools()` 中添加：

```typescript
import {
  savePresetDef, executeSavePreset,
  listPresetsDef, executeListPresets,
  deletePresetDef, executeDeletePreset,
} from "./presets/tools.ts";

// 在 registerSelfTools() 中追加:
pi.registerTool({
  name: savePresetDef.name,
  label: savePresetDef.label,
  description: savePresetDef.description,
  parameters: savePresetDef.parameters,
  promptSnippet: savePresetDef.promptSnippet,
  promptGuidelines: savePresetDef.promptGuidelines,
  execute: (_id: string, params: { name: string }) => executeSavePreset(params),
});

pi.registerTool({
  name: listPresetsDef.name,
  label: listPresetsDef.label,
  description: listPresetsDef.description,
  parameters: listPresetsDef.parameters,
  promptSnippet: listPresetsDef.promptSnippet,
  promptGuidelines: listPresetsDef.promptGuidelines,
  execute: () => executeListPresets(),
});

pi.registerTool({
  name: deletePresetDef.name,
  label: deletePresetDef.label,
  description: deletePresetDef.description,
  parameters: deletePresetDef.parameters,
  promptSnippet: deletePresetDef.promptSnippet,
  promptGuidelines: deletePresetDef.promptGuidelines,
  execute: (_id: string, params: { name: string }) => executeDeletePreset(params),
});
```

---

## 5. 边界条件

| 场景 | 处理 |
|------|------|
| save_preset 时 Vision API 不可用 | 返回错误，预设不保存 |
| save_preset 时截图失败 | 返回错误 |
| save_preset 时某类 actor 不存在 | `capturePresetState()` 记录到 `missingActors`，不阻断 |
| save_preset 时同名预设已存在 | 返回 `{ success: false, error: "..." }`，提示先 delete_preset |
| 预设名含特殊字符 | 当前不做校验——假设 LLM 生成合法 kebab-case |
| `~/.pi/agent/presets/` 首次创建 | `savePresetEntry()` 自动 `mkdirSync({ recursive: true })` |

---

## 6. 独立测试

### 6.1 可测项

| 函数 | 可测性 | 测试方式 |
|------|:--:|------|
| `capturePresetState()` | ❌ | 依赖 UE MCP 连接（需运行中的 UE 实例 + MCP Server） |
| `executeSavePreset()` | ❌ | 依赖 UE MCP + Vision API |
| `executeListPresets()` | ⚠️ | 依赖文件系统，可用 tmp 目录间接测试（复用 store 测试） |
| `executeDeletePreset()` | ⚠️ | 同上 |

### 6.2 跳过项

008b 的所有核心逻辑依赖外部服务（UE MCP、Vision API）或 008a 已覆盖的 store 函数。工具 execute() 函数的测试应在 008e 的集成测试中通过实际 UE 场景进行端到端验证。

### 6.3 可间接验证的点

测试文件：`packages/ue-harness/test/presets-tools.test.ts`

```typescript
// Case 1: savePresetDef 的 TypeBox schema 编译正确
//   Type.Strict(savePresetDef.parameters) → 不抛异常
//   schema 接受 { name: "valid-name" }
//   schema 拒绝 { name: 123 }（TypeBox 类型校验）

// Case 2: listPresetsDef / deletePresetDef / loadPresetDef 同理
//   所有工具定义的 parameters schema 可编译

// Case 3: 工具 execute() 在 UE 未连接时返回错误
//   模拟 getUeClient() 返回 null / isConnected === false
//   execute*() 返回 { isError: true, content: [{ text: "..." }] }
```

---

## 7. 验收标准

1. 在 UE 中调参完成后，`save_preset("test-preset")` → `~/.pi/agent/presets/test-preset/` 包含 `preset.json` + `test-preset.png`
2. `preset.json` 的 `tags` 字段 5 维度完整，`freeformTags` 为数组，`actors` 包含场景中存在的氛围组件
3. `list_presets()` 返回包含刚创建的预设
4. `save_preset` 对已存在的名称返回错误
5. `delete_preset("test-preset")` 后 `list_presets()` 不再包含该预设

---

## 8. 与后续 Issue 的接口

| 元素 | 后续使用者 |
|------|------|
| 3 个工具注册 | index.ts（008c/008d 追加新工具不冲突） |
| `capturePresetState()` | 仅 008b |
| `CaptureResult` | 仅 008b |
