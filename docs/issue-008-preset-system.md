# Issue 008 — 预设系统设计

**状态**: 待审阅
**优先级**: P1
**依赖**: Issue 003-005 已完成（需要 assess_lighting 的氛围特征 + set_properties 能力）
**预计时长**: 5-7 天

---

## 1. 动机

当前每次输入参考图，LLM 都需要从默认场景状态开始，经历 SETUP → TUNING Tier 1 → Tier 2 → Tier 3 的完整流程。如果之前对类似的参考图做过匹配并产出了满意结果，这些经验被丢弃了。

预设系统让 LLM 把"调好的参数 + 对应的场景特征"保存为预设。下次遇到类似参考图时，直接加载预设作为起点，跳过探索阶段。

---

## 2. 流程设计

### 2.1 保存流程

```
LLM 调参完成 → 用户确认满意
       │
       ▼
  LLM 调 save_preset(name, description, reference_path)
       │
       ├── 拷贝参考图 (如果路径有效)
       │     cp <reference_path> → ~/.pi/agent/presets/<name>/<original_filename>
       │     保留原始文件名，不重命名
       │
       ├── capturePresetState()
       │     │
       │     ├── find_actors (5 类氛围组件)
       │     ├── get_properties (每组件的光照属性)
       │     ├── get_actor_transform (DirectionalLight 旋转)
       │     └── 组装 PresetEntry
       │
       ├── 提取当前氛围特征 (assess_lighting 最后一次结果)
       │
       └── 写入 ~/.pi/agent/presets/<name>/preset.json
```

一条预设包含：

```json
{
  "name": "golden-hour-sunset",
  "description": "Warm golden hour sunset with low-angle light, orange-purple sky gradient, heavy atmospheric fog with warm inscattering",
  "atmosphere_signature": {
    "light_direction":   { "rating": 4, "desc": "low-angle side light from right" },
    "color_temperature": { "rating": 5, "desc": "warm golden" },
    "brightness":        { "rating": 2, "desc": "moderately dark, dusk feel" },
    "contrast":          { "rating": 4, "desc": "high contrast, bright highlights" },
    "color_cast":        { "rating": 1, "desc": "no global cast" },
    "saturation":        { "rating": 3, "desc": "moderate saturation" },
    "atmosphere":        { "rating": 4, "desc": "heavy fog with warm glow" },
    "shadow_depth":      { "rating": 5, "desc": "deep shadows" }
  },
  "created": "2026-08-10T15:00:00Z",
  "reference_image": "sunset_beach.png",
  "reference_original_path": "D:/References/sunset_beach.png",
  "actors": {
    "DirectionalLight_0": {
      "refPath": "/Game/Main.Main:PersistentLevel.DirectionalLight_0",
      "transform": {
        "rotation": { "Pitch": -30, "Yaw": 60, "Roll": 0 }
      },
      "components": {
        "LightComponent0": {
          "LightColor": { "r": 1.0, "g": 0.85, "b": 0.5, "a": 1.0 },
          "Intensity": 8.0,
          "Temperature": 4500.0,
          "LightSourceAngle": 1.5
        }
      }
    },
    "SkyLight_0": {
      "refPath": "/Game/Main.Main:PersistentLevel.SkyLight_0",
      "components": {
        "SkyLightComponent": {
          "Intensity": 2.5,
          "LightColor": { "r": 0.9, "g": 0.85, "b": 1.0, "a": 1.0 }
        }
      }
    },
    "SkyAtmosphere_0": {
      "refPath": "/Game/Main.Main:PersistentLevel.SkyAtmosphere_0",
      "components": {
        "SkyAtmosphereComponent": {
          "MieScatteringScale": 0.02,
          "MieScattering": { "r": 1.0, "g": 0.8, "b": 0.6 },
          "MieExponentialDistribution": 0.7,
          "RayleighScatteringScale": 0.005
        }
      }
    },
    "ExponentialHeightFog_0": { /* ... */ },
    "VolumetricCloud_0": { /* ... */ }
  },
  "postprocess_reset": true
}
```

### 2.2 命中/加载流程

```
用户输入参考图 → map_atmosphere + assess_lighting 完成
       │
       ▼
  matchPresets(referenceAtmosphere)
       │
       ├── 加载所有预设的 atmosphere_signature
       ├── 对每条预设计算匹配分:
       │     │
       │     ├── rating 向量余弦相似度 (8 维, 权重 0.6)
       │     ├── description 文本相似度 (TF-IDF/关键词重叠, 权重 0.3)
       │     └── color_temperature 方向相似度 (warm/cool/neutral, 权重 0.1)
       │
       ├── 排序取 top-3 (匹配分 >= 0.6 的)
       │
       └── 注入 before_agent_start:
             "以下预设与当前参考图特征相似 (匹配分降序):
                1. golden-hour-sunset (0.87) — Warm golden hour sunset...
                2. purple-dusk (0.72) — Purple-pink dusk with soft fog...
             [如果你认为其中某个预设比当前默认场景更适合作为起点，
              请调 load_preset('preset-name') 加载。]"
```

命中判断由三部分组成：

| 信号 | 权重 | 说明 |
|------|:--:|------|
| 8 维度 rating 余弦相似度 | 0.6 | 两个 8 维 rating 向量 [4,5,2,4,1,3,4,5] vs [5,5,1,3,1,2,3,4] 的余弦距离 |
| 描述关键词重叠 | 0.3 | "low-angle warm sunset fog" vs "warm golden hour fog" — 词级 Jaccard 相似度 |
| 色温方向一致性 | 0.1 | 都是 warm → +0.1；一冷一暖 → 0；都是 neutral → +0.05 |

### 2.3 应用流程

```
LLM 决定加载预设 → load_preset("golden-hour-sunset")
       │
       ▼
  applyPreset(preset)
       │
       ├── 第一阶段: 角色变换 (DirectionalLight rotation)
       │     set_actor_transform(DirectionalLight_0, preset rotation)
       │
       ├── 第二阶段: 批量属性 (所有组件属性)
       │     for each actor in preset.actors:
       │       for each component in actor:
       │         set_properties(component.refPath, component.properties)
       │
       ├── 第三阶段: 后处理重置 (如果 postprocess_reset = true)
       │     回退 PostProcessVolume 到默认值
       │
       └── 返回摘要:
             "预设 'golden-hour-sunset' 已加载。
              设置: DirectionalLight (6 属性), SkyLight (2 属性),
                    SkyAtmosphere (4 属性), ExponentialHeightFog (4 属性)。
              回退: PostProcessVolume (默认值)。
              缺失: VolumetricCloud_0 (场景中不存在)。"
```

---

## 3. 模块拆分

```
packages/ue-harness/src/presets/
├── types.ts               — PresetEntry, PresetActor, PresetMatch 类型
├── store.ts               — 预设 CRUD (~/.pi/agent/presets/<name>.json)
├── capture.ts             — capturePresetState(): 快照场景中 5 类氛围组件的当前属性
├── apply.ts               — applyPreset(): 批量 set_properties + set_actor_transform
├── match.ts               — findMatchingPresets(): 8 维 rating 余弦相似度 + 关键词匹配
└── tools.ts               — save_preset / load_preset / list_presets / delete_preset 工具定义

packages/ue-harness/src/index.ts  (改动)
├── session_start: 加载已有预设列表
├── registerSelfTools: 注册 4 个预设工具
└── before_agent_start: 注入匹配的预设建议 (assess_lighting 完成后)
```

---

## 4. 工具 API 设计

### 4.1 `save_preset(name, description?, reference_path?)`

```
save_preset("golden-hour-sunset", "Warm golden hour sunset...", "sunset_beach.png")
  → 内部:
    1. 如果 reference_path 有效: 拷贝图片到 ~/.pi/agent/presets/golden-hour-sunset/sunset_beach.png
    2. caputurePresetState() 扫描场景 + 获取氛围特征
    3. 保存到 ~/.pi/agent/presets/golden-hour-sunset/preset.json
  → 返回: { saved: true, name: "golden-hour-sunset", actor_count: 5,
             reference_copied: true }
```

每套预设是一个子目录，包含预设 JSON 和参考图副本:

```
~/.pi/agent/presets/
├── golden-hour-sunset/
│   ├── preset.json
│   └── sunset_beach.png       ← 参考图副本 (保留原始文件名)
├── purple-dusk/
│   ├── preset.json
│   └── purple_dusk_ref.png
└── foggy-morning/
    ├── preset.json
    └── morning_fog.png
```

参考图副本的作用:
- 预设自包含，不依赖外部路径
- 后续可对比：当前场景 vs 预设参考图 (Vision 直接读本地图片)
- 跨设备迁移预设时，图片跟随 JSON 一起走
- `reference_original_path` 保留原始路径用于调试追溯，但加载预设时不依赖它

### 4.2 `list_presets()`

```
list_presets()
  → 返回: {
      presets: [
        { name: "golden-hour-sunset", description: "...", created: "...",
          atmosphere_signature: {...},
          reference_image: "sunset_beach.png" },
        { name: "purple-dusk", ... }
      ]
    }
```

### 4.3 `load_preset(name)`

```
load_preset("golden-hour-sunset")
  → 内部: applyPreset(preset)
  → 返回: {
      loaded: true,
      applied: { DirectionalLight_0: 6, SkyLight_0: 2, SkyAtmosphere_0: 4, ExponentialHeightFog_0: 4 },
      skipped: { VolumetricCloud_0: "actor not found in scene" },
      reset_postprocess: true
    }
```

### 4.4 `delete_preset(name)`

```
delete_preset("golden-hour-sunset")
  → 删除整个目录 ~/.pi/agent/presets/golden-hour-sunset/
  → 返回: { deleted: true, name: "golden-hour-sunset" }
```

---

## 5. 边界条件

| 场景 | 处理 |
|------|------|
| 保存时 reference_path 无效或图片不存在 | 跳过拷贝步骤，`reference_copied: false`，`reference_image` 为空。预设仍可正常保存（无参考图副本） |
| 保存时预设目录已存在同名图片 | 覆盖旧图片 |
| 卸载预设时参考图副本损坏/丢失 | `load_preset` 不受影响（只读 JSON）；后续对比功能提示图片缺失 |
| 场景中不存在预设中的 actor | 跳过该 actor，在返回中报告 "skipped: actor not found"。不影响其他 actor |
| 预设中有属性但当前组件不支持 | 跳过该属性，继续设置其他属性 |
| set_properties 部分失败 | 捕获错误，继续其他组件，在返回中汇总失败项 |
| 预设文件 JSON 损坏 | `store.ts` 加载时跳过损坏文件，`list_presets()` 中标记为 corrupted |
| 同名预设覆盖 | `save_preset` 要求用户确认（通过 `pi.ui.confirm()` 或上下文注入） |
| 大预设（>20 个组件） | 不做分批——直接 for 循环，UE MCP Server 串行处理 |
| Vision API 不可用 | 预设匹配退化为纯关键词匹配（description 文本相似度） |
| 没有任何预设 | `matchPresets` 返回空数组，`before_agent_start` 不注入预设建议 |
| 多个预设匹配分接近（差 < 0.05） | 全部列出，由 LLM 选择 |
| 加载预设后 Phase 状态 | 保持在 SETUP——LLM 仍需调 `assess_lighting` 检验预设效果 |
| 预设的来源参考图 | `source_reference` 字段记录最初产生此预设的参考图路径 |

---

## 6. `before_agent_start` 注入时机

在以下条件下注入预设建议：

```
条件:
  1. assess_lighting 已完成 (state.phase >= TUNING)
  2. state.lastGapEntries 中有参考图的氛围数据
  3. matchPresets 找到至少一个匹配分 >= 0.6 的预设
  4. 当前轮次 <= 2 (首次 assess_lighting 后的前两轮——避免重复注入)

注入文本:
  ## 匹配的预设

  以下预设与当前参考图的氛围特征相似，可能提供更好的调参起点:
    [1] golden-hour-sunset (匹配度: 0.87)
        Warm golden hour sunset with low-angle light, orange-purple sky...
    [2] purple-dusk (匹配度: 0.72)
        Purple-pink dusk with soft fog and cool shadows...

  如果你认为某个预设比当前默认场景更适合作为起点:
    调 load_preset('name') 批量应用该预设
    然后调 assess_lighting(reference_path) 检验效果

  不使用预设则忽略此建议，继续正常调参。
```

---

## 7. 预设匹配算法细节

```
function findMatchingPresets(refAtmosphere, presets):

  results = []

  for each preset:
    // 1. 8 维 rating 余弦相似度
    refVec    = [refDim1.rating, refDim2.rating, ..., refDim8.rating]
    presetVec = [preDim1.rating, preDim2.rating, ..., preDim8.rating]
    cosineSim = dot(refVec, presetVec) / (norm(refVec) * norm(presetVec))

    // 2. 描述关键词重叠
    refWords   = tokenize(refAtmosphere 各维度 desc 拼接)
    presetWords = tokenize(preset.description)
    keywordSim = |refWords ∩ presetWords| / |refWords ∪ presetWords|

    // 3. 色温方向一致性
    refColorTemp = refAtmosphere.color_temperature
    presetColorTemp = preset.atmosphere_signature.color_temperature
    if both warm or both cool: tempSim = 1.0
    elif one warm and one cool: tempSim = 0
    else: tempSim = 0.5  // neutral 混合

    totalScore = 0.6 * cosineSim + 0.3 * keywordSim + 0.1 * tempSim

    if totalScore >= 0.6:
      results.push({ name, totalScore, description })

  return results.sortedBy(totalScore.desc).slice(0, 3)
```

---

## 8. 不改动范围

1. **不自动应用预设**: LLM 始终需要主动调 `load_preset`。预设只是建议，不是强制
2. **不跨 UE 项目共享预设**: 预设绑定到 actor refPath（包含项目名如 `/Game/Main.Main:PersistentLevel.`），不同 UE 项目的 actor 路径不同
3. **不保存非氛围属性**: 只快照 5 类氛围组件（DirectionalLight, SkyLight, SkyAtmosphere, ExponentialHeightFog, VolumetricCloud）+ PostProcessVolume 回退标记。不保存材质、几何、蓝图属性
4. **不依赖 Vision API**: 预设匹配在 Vision 不可用时退化为纯关键词匹配

---

## 9. 实施 Issue 划分

| Issue | 内容 | 预计 |
|:--:|------|:--:|
| 008a | `presets/types.ts` + `store.ts` + `tools.ts` (save/list/delete) | 1 天 |
| 008b | `presets/capture.ts` + `apply.ts` (场景快照 + 批量应用) | 1.5 天 |
| 008c | `presets/match.ts` + 注入到 `before_agent_start` | 1 天 |
| 008d | 测试 + 边界条件处理 | 1 天 |

**总计**: ~4-5 天
