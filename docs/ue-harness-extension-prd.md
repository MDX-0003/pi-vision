# UE Harness Pi Extension — PRD

**状态**：已定稿，待开发
**目标**：将 UE Agent Harness 的参考图光照匹配能力作为 Pi Agent 扩展重新实现
**语言**：TypeScript（Pi Agent 扩展）
**最后更新**：2026-08-09

---

## 1. 为什么做 / 为什么用 Pi 扩展

### 1.1 当前 Harness 的根本缺陷

Python UE Agent Harness 通过**提示词注入 + Skill 文本 + Interceptor 只读观察**来间接控制 LLM 行为。三个核心问题：

1. **控制力弱**：Interceptor 的 `post_call` 不能修改结果、不能阻止调用。LLM 可以自由忽略 Skill 步骤、跳过验证、走后处理捷径
2. **只读被动**：Vision 分析作为文本注入 LLM 上下文，LLM 可以选择不看、不信、不跟
3. **纯文本约束**：Skill YAML 中的 `verification` 字段从未被执行（验证记录证实）

### 1.2 Pi 扩展提供的控制力升级

| 能力 | Harness (Python) | Pi Extension (TypeScript) |
|------|:--:|:--:|
| 阻止工具调用 | ❌ 只能建议 | ✅ `tool_call` → `{block: true}` |
| 修改工具结果 | ❌ post_call 不可改 | ✅ `tool_result` → 替换 content |
| 替换 system prompt | ❌ 只能追加 instruction | ✅ `before_agent_start` → 整体替换 |
| 结构化工具输出 | ❌ Markdown 文件 → LLM 需 read | ✅ 工具 execute() 直接返回 JSON |
| Session 持久化 | ❌ 自己实现 JSONL | ✅ Pi SessionManager 原生支持 |

### 1.3 架构对比

```
旧 (Harness):
  Claude Code ←→ Harness MCP Server (:9000) ←→ UE MCP Server (:8000)
                     ↑ Python, 独立进程
                     提示词注入 + 只读拦截器

新 (Pi Extension):
  Pi (TUI/CLI) ←→ UE Harness Extension ←→ UE MCP Server (:8000)
                      ↑ TypeScript, 同进程
                     tool_call block + before_agent_start 注入 + 结构化工具
```

---

## 2. 工具功能定稿

### 2.1 `map_atmosphere()`

**海拔**："场景里有哪些参数能控制光照氛围，按什么顺序调"

**输入**：无

**行为**：
1. `find_actors`（5 类氛围组件：DirectionalLight, SkyLight, SkyAtmosphere, ExponentialHeightFog, VolumetricCloud, PostProcessVolume）
2. 对每个找到的 Actor 调 `list_properties` → 获取属性名列表 → Vision classify（或 whitelist fallback）→ 8 维度标注
3. 按硬编码优先级输出 3 个 Tier

**返回**：
```json
{
  "tiers": [
    {
      "tier": 1,
      "label": "CORE_LIGHTING",
      "rationale": "直射光和天光决定场景所有物体的受光方向和色温基调，必须在调整大气/后处理之前先定好",
      "dimensions": ["light_direction", "color_temperature", "brightness", "shadow_depth"],
      "components": [
        {
          "actor": "DirectionalLight_0",
          "properties": [
            { "name": "LightColor", "ref_path": "DirectionalLight_0:LightColor",
              "current_value": { "R": 1.0, "G": 0.95, "B": 1.0 } },
            { "name": "Intensity", "ref_path": "DirectionalLight_0:Intensity",
              "current_value": 10.0 },
            { "name": "Rotation", "ref_path": "DirectionalLight_0:RelativeRotation",
              "current_value": { "Pitch": -45, "Yaw": 0, "Roll": 0 },
              "note": "旋转决定光源方向和它在画面中的位置，影响量化指标(亮度分布)" }
          ]
        }
      ]
    },
    {
      "tier": 2,
      "label": "ATMOSPHERE",
      "rationale": "大气雾/体积云依赖 Tier 1 的光方向和色温。光的方向决定了雾的散射颜色在画面中的表现",
      "dimensions": ["atmosphere", "haze", "sky"],
      "components": [ /* SkyAtmosphere, ExponentialHeightFog, VolumetricCloud */ ]
    },
    {
      "tier": 3,
      "label": "POSTPROCESS",
      "rationale": "后期处理是锦上添花。应在 Tier 1-2 确定后，从默认/关闭状态开始",
      "initial_state": "MUST_RESET_TO_DEFAULT_AND_DISABLE",
      "dimensions": ["contrast", "saturation", "color_cast"],
      "components": [ /* PostProcessVolume */ ]
    }
  ]
}
```

**调用频率**：每 session 1 次

---

### 2.2 `assess_lighting(reference_path)`

**海拔**："当前每个氛围维度离参考图还有多远"

**输入**：`reference_path: string` — 参考图文件路径

**行为**（双阶段并行）：
1. **Stage 1（量化指标，<10ms PIL 计算）**：亮度、色温 R/B 比、饱和度、直方图相关性。纯数据，不判断
2. **Stage 2（氛围主观验证，Vision 模型）**：单图独立分析 × 2 + 特征级对比。参考图和当前截图各自独立提取 8 维度氛围特征，每个维度 1-5 rating，然后 rating diff → gap 级别

**返回**：
```json
{
  "reference": {
    "path": "sunset_beach.png",
    "atmosphere": {
      "light_direction":   { "rating": 4, "desc": "低角度逆光，光源在画面右上方" },
      "color_temperature": { "rating": 5, "desc": "明显暖调，金色光线" },
      "brightness":        { "rating": 2, "desc": "整体偏暗，黄昏感" },
      "contrast":          { "rating": 4, "desc": "高对比，亮部与暗部反差明显" },
      "color_cast":        { "rating": 1, "desc": "无明显全局偏色" },
      "saturation":        { "rating": 3, "desc": "中等饱和度" },
      "atmosphere":        { "rating": 4, "desc": "远处有明显雾气衰减" },
      "shadow_depth":      { "rating": 5, "desc": "阴影很深，近乎黑色" }
    }
  },

  "current": {
    "atmosphere": {
      "light_direction":   { "rating": 4, "desc": "低角度光，方向与参考图一致" },
      "color_temperature": { "rating": 2, "desc": "偏冷白，荧光灯感" },
      "brightness":        { "rating": 4, "desc": "整体较亮，白天感" },
      "contrast":          { "rating": 3, "desc": "中等对比" },
      "color_cast":        { "rating": 1, "desc": "无全局偏色" },
      "saturation":        { "rating": 2, "desc": "饱和度偏低" },
      "atmosphere":        { "rating": 1, "desc": "非常清晰，无雾气" },
      "shadow_depth":      { "rating": 3, "desc": "阴影柔和透明" }
    }
  },

  "gaps": [
    {
      "dimension": "color_temperature",
      "tier": 1,
      "gap": "major",
      "direction": "too_cool",
      "rating_diff": 3,
      "quantitative": { "ref_rb_ratio": 1.42, "cur_rb_ratio": 0.95 },
      "qualitative": "参考图呈现金色暖调，当前画面偏中性白，缺少暖色感"
    },
    {
      "dimension": "atmosphere",
      "tier": 2,
      "gap": "major",
      "direction": "too_clear",
      "rating_diff": 3,
      "quantitative": null,
      "qualitative": "参考图远景有明显雾气衰减，当前场景远景轮廓清晰"
    },
    {
      "dimension": "brightness",
      "tier": 1,
      "gap": "minor",
      "direction": "slightly_bright",
      "rating_diff": 2,
      "quantitative": { "ref_luminance": 98.5, "cur_luminance": 132.7 },
      "qualitative": null
    },
    {
      "dimension": "shadow_depth",
      "tier": 1,
      "gap": "minor",
      "direction": "too_soft",
      "rating_diff": 2,
      "quantitative": null,
      "qualitative": "参考图阴影很黑，当前阴影透明感强"
    },
    {
      "dimension": "saturation",
      "tier": 3,
      "gap": "minor",
      "direction": "less_saturated",
      "rating_diff": 1,
      "quantitative": { "ref_saturation": 78.3, "cur_saturation": 65.1 },
      "qualitative": null
    },
    {
      "dimension": "light_direction",
      "tier": 1,
      "gap": "minor",
      "direction": "close_enough",
      "rating_diff": 0,
      "quantitative": null,
      "qualitative": null
    },
    {
      "dimension": "contrast",
      "tier": 3,
      "gap": "minor",
      "direction": "close_enough",
      "rating_diff": 1,
      "quantitative": null,
      "qualitative": null
    },
    {
      "dimension": "color_cast",
      "tier": 3,
      "gap": "minor",
      "direction": "close_enough",
      "rating_diff": 0,
      "quantitative": null,
      "qualitative": null
    }
  ],

  "artificiality": {
    "detected": false,
    "detail": ""
  },

  "priority": ["color_temperature", "atmosphere"]
}
```

**gap 判定规则**（硬编码，不依赖 LLM）：
- `|rating_diff| >= 3` → `major`
- `|rating_diff| == 2` → `moderate`
- `|rating_diff| <= 1` → `minor`

**artificiality 检测**：Vision 额外提问 ——"当前画面是否有'人工感'——色调像是滤镜后加的而非真实光照？"。检测到即标记。

**调用频率**：首次摸底 + 每完成一轮 Tier 调整后 + 最终确认

---

### 2.3 `check_dimension(reference_path, dimension)`

**海拔**："刚才调的这个维度，方向对了吗"

**输入**：
- `reference_path: string`
- `dimension: string` — 8 维度之一

**行为**：参考图 + 当前截图 → Vision 单维度提问（~200 token output vs assess_lighting ~2000）

**返回**：
```json
{
  "dimension": "color_temperature",
  "current_rating": 4,
  "target_rating": 5,
  "verdict": "closer",
  "gap_remaining": 1,
  "evidence": "当前色调已从冷白转为暖黄，接近参考图的金色光线"
}
```

**verdict 三态**：`closer` | `similar` | `further`

**调用频率**：高频，每次调参后。在 `assess_lighting` 全维度评估之间作为轻量方向确认

---

## 3. 工作流设计

### 3.1 Phase 状态机

```
┌──────────────────────────────────────────────────────────────┐
│  状态机由扩展代码维护（tool_result handler 驱动状态转换）      │
│  LLM 通过 before_agent_start 注入知悉当前 Phase              │
│  违规行为通过 tool_call block 阻止                            │
└──────────────────────────────────────────────────────────────┘

  SETUP ──assess_lighting完成──► TUNING(Tier 1)
                                      │
                            Tier 1 gaps全部minor
                                      │
                                      ▼
                                TUNING(Tier 2)
                                      │
                            Tier 2 gaps全部minor
                                      │
                                      ▼
                            POSTPROCESS_SETUP
                            (回退默认值→设参数→enable)
                                      │
                                      ▼
                                TUNING(Tier 3)
                                      │
                            Tier 3 gaps全部minor
                                      │
                                      ▼
                            FINAL_VERIFICATION
                            (最后一次assess_lighting
                             → artificiality检查)
                                      │
                              ┌───────┴───────┐
                              │               │
                         artificiality    artificiality
                         = false          = true
                              │               │
                              ▼               ▼
                            DONE        回退PostProcess
                                        → 重回 TUNING(Tier 1)
```

### 3.2 Tier 门控规则

| 当前 Tier | 允许调 | 禁止调 | 进入下一 Tier 的条件 |
|:--:|------|------|------|
| 1 | DirectionalLight, SkyLight | SkyAtmosphere, Fog, Cloud, PostProcess | 所有 Tier 1 维度 gap = minor |
| 2 | Tier 1 参数 + SkyAtmosphere, Fog, Cloud | PostProcess | 所有 Tier 2 维度 gap = minor |
| 3 | 全部 | —（但需先完成 POSTPROCESS_SETUP） | 所有 Tier 3 维度 gap = minor |

Tier 门控由 `tool_call` handler 检查，是**硬约束**——LLM 无法绕过。

### 3.3 POSTPROCESS_SETUP 特殊规则

```
强制步骤（违反则 tool_call block）:
  1. set_properties 将 PostProcessVolume 所有 color grading 参数回退到默认值
  2. 设 visible = false (或 Actor HiddenInGame = true)
  3. 禁止在此阶段调用任何截图工具
  4. LLM 设好目标参数 + visible = true 后可进入 TUNING

防呆检查:
  - PostProcessVolume visible=true && 所有 color grading = 默认值
    → 如果 LLM 试图截图 → block: "后处理当前为默认值，截图无意义"
```

### 3.4 停止条件

| 条件 | 行为 |
|------|------|
| 所有维度 gap = minor (8/8) | ✅ DONE |
| 3 轮（assess_lighting 调用次数）内无维度 gap 变化 | ⚠️ 可能到物理极限 → 提示用户 |
| artificiality.detected = true | ⚠️ 回退 PostProcess 到默认 → 重回 TUNING(Tier 1) |
| 总 assess_lighting 调用 ≥ 15 次 | 🛑 硬停止 → 报告最终状态 |

### 3.5 减少无效截图的机制汇总

| 机制 | 解决的问题 | 实现方式 |
|------|-----------|---------|
| **Phase 门控** | 不对的时机截图 | `tool_call` block |
| **批量写入** | 每改一个参数就截一张 | TUNING 不强制每次 set_properties 后验证。LLM 自主决定何时调 check_dimension |
| **Tier 锁定** | 跳过前置步骤直接调后处理 | `map_atmosphere` 输出 tier → `tool_call` block 阻止跨 tier 写入 |
| **默认值检测** | enable 一个默认值的组件后截无效图 | POSTPROCESS_SETUP 特殊处理 |
| **硬上限** | 无限循环 | 总 assess_lighting ≤ 15 次，单维度 check_dimension ≤ 20 次 |

---

## 4. 整体架构

### 4.1 代码结构

```
.pi/extensions/ue-harness/           # Pi 扩展目录（项目级）
├── package.json                      # 扩展依赖 (sharp, @modelcontextprotocol/sdk)
├── index.ts                          # export default function(pi: ExtensionAPI)
│
├── ue-client/
│   ├── mcp-client.ts                 # UE MCP JSON-RPC 2.0 客户端
│   │                                 #   · listTools() → Tool[]
│   │                                 #   · callTool(name, args) → string
│   │                                 #   · SSE event-stream 双阶段解析
│   │                                 #   · 连接管理 (connect/disconnect/reconnect)
│   ├── schema-converter.ts           # JSON Schema → TypeBox schema 自动转换
│   │                                 #   处理 oneOf, enum, $ref, nested object
│   └── types.ts                      # UeTool, UeToolSchema, UeCallResult
│
├── tools/
│   ├── map-atmosphere.ts             # Tool A: 场景参数发现
│   │                                 #   · 5类组件扫描 → find_actors
│   │                                 #   · 属性发现 → list_properties
│   │                                 #   · Vision classify → 维度标注
│   │                                 #   · whitelist fallback (50+ 已知氛围属性)
│   │                                 #   · Tier 编排输出
│   ├── assess-lighting.ts            # Tool B: 全维度双重评估
│   │                                 #   · Stage 1: PIL 量化指标 (sharp)
│   │                                 #   · Stage 2: Vision 氛围分析 (Vision)
│   │                                 #   · 特征对比 (rating diff → gap)
│   │                                 #   · artificiality 检测
│   └── check-dimension.ts            # Tool C: 单维度方向性验证
│       #   · 轻量 Vision 调用 (1维度 ~200 output tokens)
│       #   · closer/similar/further 三态
│
├── vision/
│   ├── capture.ts                     # 截图工具封装 (ViewportCaptureToolset)
│   │                                 #   · CaptureViewportImage → 文件路径 → fs.readFileSync → base64
│   │                                 #   · ResolutionMultiplier: 1.0 (默认) / 2.0 (超采样)
│   │                                 #   · 返回文件路径 (非 base64)，避免 MCP 巨型 payload
│   │                                 #   · 不依赖 DWM，UE 最小化/后台时仍可用
│   ├── vision-client.ts                # Vision API HTTP 客户端
│   │                                 #   · 独立于 Pi ModelRuntime
│   │                                 #   · 支持图片 base64 发送
│   │                                 #   · 结构化 JSON 响应解析
│   ├── metrics.ts                    # 量化指标计算 (sharp/jimp)
│   │                                 #   · luminance, contrast
│   │                                 #   · R/B color temperature ratio
│   │                                 #   · saturation, histogram correlation
│   └── prompts.ts                    # Vision prompt 模板
│       #   · 8维度氛围特征提取 prompt
│       #   · 单维度方向判定 prompt
│       #   · artificiality 检测 prompt
│
├── workflow/
│   ├── phase-machine.ts              # Phase/Tier 状态机
│   │                                 #   · Phase enum: SETUP/TUNING/POSTPROCESS_SETUP/FINAL
│   │                                 #   · 状态转换逻辑 (tool_result handler)
│   │                                 #   · currentTier/currentPhase 维护
│   ├── guard-rules.ts                # tool_call block 规则引擎
│   │                                 #   · Tier 门控检查
│   │                                 #   · 截图无效触发检测
│   │                                 #   · PostProcess 默认值检测
│   │                                 #   · 硬上限计数
│   └── injections.ts                 # before_agent_start 注入
│       #   · Phase/Tier 状态文本
│       #   · 当前 gap 摘要
│       #   · 允许/禁止的行为列表
│
└── skills/
    ├── match-atmosphere.md            # 参考图氛围匹配 Skill (Markdown + YAML frontmatter)
    ├── scene-lighting.md              # 场景灯光精确调整 Skill
    └── color-diagnostics.md           # 颜色诊断决策树 (7种色调偏移)
```

### 4.2 运行时的数据流

```
Session Start
  │
  ▼
┌─ pi.on("session_start") ────────────────────────────────────┐
│  ueClient.connect("http://localhost:8000")                  │
│  ueTools = ueClient.listTools()                             │
│  // 强制排除 CaptureEditorImage (DWM 依赖)                   │
│  excludedToolNames = ["*CaptureEditorImage"]                 │
│  for each ueTool: pi.registerTool(convertToPiTool(ueTool)) │
│  pi.registerTool(mapAtmosphereDef)                          │
│  pi.registerTool(assessLightingDef)                          │
│  pi.registerTool(checkDimensionDef)                          │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ pi.on("tool_call") ───────────────────────────────────────┐
│  guardRules.check(event) → block? yes → {block, reason}    │
│  · Tier 门控                                               │
│  · Phase 约束                                               │
│  · 截图无效触发检测                                          │
│  · 硬上限检查                                                │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ pi.on("tool_result") ─────────────────────────────────────┐
│  if (event.toolName === "assess_lighting"):                │
│    phaseMachine.transition(parseResult(event))             │
│  if (event.toolName === "map_atmosphere"):                │
│    guardRules.loadTierMap(parseResult(event))              │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ pi.on("before_agent_start") ──────────────────────────────┐
│  injections.buildContext({                                 │
│    phase: phaseMachine.currentPhase,                       │
│    tier: phaseMachine.currentTier,                         │
│    gaps: lastAssessment.gaps,                              │
│    artificiality: lastAssessment.artificiality             │
│  })                                                        │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Issue 划分

### Issue 001：UE MCP 连通性验证（Spike）

**优先级**：P0 — 第一个完成。后续所有 Issue 的硬依赖
**预计时长**：2–3 天
**依赖**：无

**目标**：验证从 Node.js/TypeScript 环境中可以稳定调用 UE MCP Server 的工具

**任务**：

| # | 任务 | 详情 |
|:--:|------|------|
| 1.1 | MCP Client 最小实现 | 使用 `@modelcontextprotocol/sdk` 的 `Client` + `StreamableHTTPClientTransport`。封装 `listTools()` 和 `callTool(name, args)` |
| 1.2 | tools/list 验证 | 调 UE :8000 的 `tools/list`，验证能获取完整工具列表（预期 200+ 工具） |
| 1.3 | 代表性工具调用 | 选 5 个代表性工具做端到端调通：`find_actors`(glob 查询)、`get_properties`(属性读取)、`set_properties`(属性写入)、`CaptureViewportImage`(截图，ViewportCaptureToolset，返回文件路径)、`get_actor_transform`(变换读取) |
| 1.4 | SSE 解析验证 | 验证长时间工具调用的 SSE event-stream 解析（ping 心跳处理、分帧重组、超时重连） |
| 1.5 | JSON Schema 提取 | 从 `tools/list` 返回中提取一个工具的 JSON Schema，手动检查字段完备性 |

**交付物**：
- `ue-client/mcp-client.ts` — 可独立测试的 `UeClient` 类
- 5 个工具的端到端测试脚本（记录实际请求/响应）
- JSON Schema 样本 → 为 002 的自动转换做准备

**验证标准**：
- [ ] `listTools()` 返回 ≥ 150 个工具
- [ ] `callTool("SceneTools.find_actors", {glob: "*Light*", tag: ""})` 返回有效 JSON
- [ ] `callTool("ObjectTools.set_properties", {...})` 写入成功 → `get_properties` 读回一致
- [ ] `CaptureViewportImage` (ViewportCaptureToolset) 返回有效截图文件路径 → 文件存在且 ≥ 100KB
- [ ] SSE 事件在 30s+ 的工具调用中正确分帧，无数据丢失
- [ ] MCP 连接断开后自动重连（最多 3 次）

**不做的**：
- JSON Schema → TypeBox 自动转换（002 做）
- 工具注册到 Pi（002 做）
- Vision 分析（003 做）

---

### Issue 002：MCP Bridge — 动态工具注册

**优先级**：P0
**预计时长**：1–2 周
**依赖**：Issue 001 ✅

**目标**：让 UE 的 200+ 工具作为 Pi Agent 工具可用，LLM 可以直接调用

**任务**：

| # | 任务 | 详情 |
|:--:|------|------|
| 2.1 | JSON Schema → TypeBox 自动转换器 | 处理：`type/string/number/boolean/object/array` 映射、`enum` 限制、`oneOf/anyOf` 展开、`$ref` 解析、嵌套 object 递归转换、required 字段标记 |
| 2.2 | UE 工具 execute() 封装 | 每个 UE 工具 → `ToolDefinition`，`execute()` 内部：参数 TypeBox 校验 → MCP `tools/call` HTTP 请求 → SSE 解析 → `AgentToolResult`。错误分类：timeout / server_error / tool_not_found / validation_error |
| 2.3 | session_start 批量注册 | `pi.on("session_start")` → `ueClient.connect()` → `listTools()` → 遍历 → `pi.registerTool()`。session_shutdown → 断开连接 |
| 2.4 | 扩展骨架搭建 | `index.ts` 入口、`pi.registerTool` 的 3 个自研工具占位、事件监听注册 |
| 2.5 | 工具白名单过滤 | 强制排除 `ToolsetRegistry.EditorAppToolset.CaptureEditorImage`（依赖 DWM，窗口最小化即失败）。所有截图使用 `ViewportCaptureToolset.ViewportCaptureToolset.CaptureViewportImage`（GPU Render Target 读回，返回文件路径）。其他 UE 工具默认全量暴露 |

**交付物**：
- `ue-client/schema-converter.ts` — `jsonSchemaToTypeBox(schema: JSONSchema): TSchema`
- `ue-client/mcp-client.ts` 增强 — 错误分类、重连逻辑
- `index.ts` — 扩展入口，含 session_start/session_shutdown 事件处理
- 测试脚本：用 curl 或 Pi 测试模式验证 LLM 可调 UE 工具

**验证标准**：
- [ ] 200+ UE 工具全部注册成功，Pi 的 `tools/list` 可见
- [ ] TypeBox schema 转换覆盖所有 UE 使用的 JSON Schema 构造（enum, oneOf, nested object, $ref）
- [ ] LLM 调 `find_actors({glob: "*Light*", tag: ""})` → 返回正确的 actor 列表
- [ ] LLM 调 `set_properties(...)` → 参数校验失败时返回可理解的错误信息
- [ ] UE MCP Server 重启后→ 扩展自动重连 → 工具仍可用
- [ ] 工具调用超时（>60s）→ 返回 timeout 错误 → LLM 可以理解并重试

**风险**：
- UE 工具的 JSON Schema 可能包含 Pi 不支持的构造（如 `oneOf` 中嵌套 `$ref`）。需在 schema-converter 中做兜底——转换失败的工具标记为 "unavailable" 但不阻断整体注册

**预期代码量**：~800–1200 行 TS

---

### Issue 003：Vision 管线 — `assess_lighting`

**优先级**：P0
**预计时长**：1–2 周
**依赖**：Issue 002 ✅

**目标**：实现核心 Vision 工具 `assess_lighting`——双阶段评估（量化指标 + Vision 主观分析）→ 每维度 gap 报告

**任务**：

| # | 任务 | 详情 |
|:--:|------|------|
| 3.1 | Vision API 客户端 | 独立于 Pi ModelRuntime 的 HTTP 客户端。支持图片 base64 发送（resize 1024×768 保持宽高比）。结构化 JSON 响应解析。错误重试 |
| 3.2 | 量化指标模块 | 用 `sharp` 实现 4 项指标：亮度均值、色温 R/B 比、饱和度、直方图相关性。纯同步计算，<10ms |
| 3.3 | Vision prompt 模板 | 8 维度氛围特征提取 prompt（单图独立分析版） + 结构化 JSON 输出约束。每个维度输出 rating(1-5) + description |
| 3.4 | assess_lighting 工具实现 | 参考图加载 → Stage 1 (PIL) + Stage 2 (Vision) 并行 → 特征对比 (rating diff → gap) → gap 排序 → artifiicality 检测 |
| 3.5 | 截图工具识别 | `CaptureEditorImage` (EditorAppToolset) 或 `Screenshot` (SlateInspector) → 识别并拦截截图结果 → 存为当前 screenshot base64 |

**交付物**：
- `vision/vision-client.ts` — Vision API 封装
- `vision/metrics.ts` — 4 项量化指标计算
- `vision/prompts.ts` — Vision prompt 模板
- `tools/assess-lighting.ts` — assess_lighting 工具完整实现

**验证标准**：
- [ ] `assess_lighting("sunset_beach.png")` → 返回结构正确的 JSON（8 维度 rating + gaps + artificiality）
- [ ] 对同一张参考图 + 同一张截图 → 连续 5 次调用 → gaps 的 gap 级别（major/moderate/minor）一致率 ≥ 80%
- [ ] 量化指标的计算结果与 Python harness 的 `compute_match_metrics()` 一致（误差 < 5%）
- [ ] Vision 调用失败时 → 返回 `{error: "vision_unavailable"}` → 不阻断主流程
- [ ] artificiality 检测：给一张 PostProcess 滤镜过度的场景 → `artificiality.detected = true`
- [ ] Vision token 消耗：每次 `assess_lighting` ≤ 3000 output tokens

**风险**：
- Vision 不稳定（Python harness 已有记录）→ 需要 whitelist fallback 策略
- Vision rating 的一致性（同一场景多次评定）→ 允许 ±1 rating 波动，gap 判定用硬编码阈值而非 LLM 直接输出

**预期代码量**：~1000–1500 行 TS

---

### Issue 004：场景发现 + 快速验证 — `map_atmosphere` + `check_dimension`

**优先级**：P0
**预计时长**：1 周
**依赖**：Issue 002 ✅ + Issue 003 ✅

**目标**：实现辅助工具——场景参数发现和单维度快速验证

**任务**：

| # | 任务 | 详情 |
|:--:|------|------|
| 4.1 | map_atmosphere 实现 | 5 类组件 `find_actors` + `list_properties` + Vision classify/whitelist fallback + 3 Tier 编排 + current_value 回填 |
| 4.2 | whitelist fallback | 从 Python harness 迁移 ~50 个已知氛围属性的硬编码映射（dimension → 属性名模式） |
| 4.3 | check_dimension 实现 | 参考图 + 当前截图 → Vision 单维度提问 → closer/similar/further + rating diff |
| 4.4 | 截图复用 | `assess_lighting` 的截图结果缓存 30s，`check_dimension` 如果距离上次截图 < 30s 且场景无变化 → 复用 |

**交付物**：
- `tools/map-atmosphere.ts`
- `tools/check-dimension.ts`
- whitelist JSON 文件（dimension → property name patterns）

**验证标准**：
- [ ] `map_atmosphere()` → 正确识别场景中所有 5 类氛围组件
- [ ] 场景中只有 1 个 DirectionalLight → `found: true, count: 1`
- [ ] 场景中没有 VolumetricCloud → `found: false, hint: "请调 add_to_scene_from_class 创建"`
- [ ] whitelist fallback：Vision 不可用时 → 仍输出维度→属性映射（覆盖率 ≥ 80%）
- [ ] `check_dimension(ref, "color_temperature")` → Vision output ≤ 300 tokens
- [ ] 连续 3 次相同的 `check_dimension` 调用 → verdict 一致率 ≥ 80%

**预期代码量**：~800–1000 行 TS

---

### Issue 005：工作流编排 — Phase 状态机 + Tier 门控

**优先级**：P0
**预计时长**：1–2 周
**依赖**：Issue 002 ✅ + Issue 003 ✅ + Issue 004 ✅

**目标**：实现完整的工作流编排——Phase 状态机、Tier 门控强制、`tool_call` block 规则引擎、`before_agent_start` 上下文注入

**任务**：

| # | 任务 | 详情 |
|:--:|------|------|
| 5.1 | Phase 状态机 | Phase enum (SETUP/TUNING/POSTPROCESS_SETUP/FINAL), 状态转换逻辑（在 `tool_result` handler 中根据 `assess_lighting` 返回的 gaps 判断），currentPhase + currentTier 维护 |
| 5.2 | Tier 门控规则 | `tool_call` handler 中检查：目标参数的 tier vs currentTier。跨 tier 且前置 tier 有 unresolved gaps → block。规则表硬编码 |
| 5.3 | 截图防呆规则 | POSTPROCESS_SETUP phase 禁止截图。默认值+visible 状态禁止截图。截图硬上限：`assess_lighting` ≤ 15 次，`check_dimension` ≤ 20 次 per session |
| 5.4 | before_agent_start 注入 | 根据当前 Phase/Tier → 生成上下文文本："当前 Phase: TUNING (Tier 1)。可以调: DirectionalLight, SkyLight。禁止调: PostProcess, Fog。完成条件: 所有 Tier 1 维度 gap=minor" |
| 5.5 | artificiality 响应 | 检测到人工感 → 强制回退规则（block PostProcess color grading 参数） + 提示 LLM 从光源重新开始 |
| 5.6 | 停止条件实现 | 全维度 minor → DONE。3 轮无变化 → 提示用户。15 次硬上限 → 报告状态 |

**交付物**：
- `workflow/phase-machine.ts`
- `workflow/guard-rules.ts`
- `workflow/injections.ts`

**验证标准**：
- [ ] 场景：Tier 1 gap=major, LLM 试图调 PostProcess → `tool_call` 返回 blocked + reason
- [ ] 场景：Tier 1 全部 minor → 状态自动转换到 TUNING(Tier 2) → LLM 可调 Fog
- [ ] 场景：POSTPROCESS_SETUP phase, LLM 试图截图 → blocked
- [ ] 场景：连续 3 轮 assess_lighting gap 无变化 → 提示注入："gap 连续 3 轮无变化，可能已达物理极限。请确认是否继续"
- [ ] 场景：第 15 次 assess_lighting → 硬停止 → 报告最终状态："已达到最大评估次数。当前 gap 状态: {summary}"
- [ ] `before_agent_start` 注入的内容准确反映当前 Phase/Tier/gaps

**预期代码量**：~800–1200 行 TS

---

### Issue 006：打磨 — Skills 迁移 + 文档 + 可观测性

**优先级**：P1
**预计时长**：1 周
**依赖**：Issue 005 ✅

**目标**：将 Python harness 的工作流 Skill 迁移为 Pi 格式、编写文档、添加可观测性

**任务**：

| # | 任务 | 详情 |
|:--:|------|------|
| 6.1 | Skills 迁移 | 将 `match-atmosphere` / `scene-lighting` / `color-diagnostics` 从 YAML 格式转为 Markdown + YAML frontmatter（Pi 格式）。放在 `.pi/skills/` |
| 6.2 | color-diagnostics | 7 种色调偏移类型识别决策树。root cause → priority action 映射。人工感检测增强（配合 artificiality） |
| 6.3 | 架构文档 | 扩展架构概述、工具 API 文档、工作流设计说明、配置指南（.env 中的 MIMO_API_KEY、UE_MCP_URL 等） |
| 6.4 | 可观测性 | 工具调用日志（结合 Pi 原生 SessionManager）、Vision token 消耗统计、Phase 转换历史、gap 变化趋势 |
| 6.5 | 错误恢复 | UE MCP 连接断开 → 自动重连 + 提示 LLM。Vision 超时 → fallback。工具调用异常 → 结构化错误反馈 |

**交付物**：
- `skills/match-atmosphere.md`
- `skills/scene-lighting.md`
- `skills/color-diagnostics.md`
- `docs/ue-harness-extension-architecture.md`（架构文档）
- `docs/ue-harness-extension-tools.md`（工具 API 文档）

**验证标准**：
- [ ] `/skill:match-atmosphere` → Skill 内容正确展开为 XML 内联
- [ ] color-diagnostics：给定"画面偏绿"场景 → 正确诊断 root cause 并建议 priority action
- [ ] 架构文档包含：数据流图、工具签名表、配置环境变量列表
- [ ] UE 连接断开 → 扩展日志记录 → 自动重连 → LLM 收到提示 "UE 连接已恢复，请继续"
- [ ] 一次完整的 "按参考图调光" SOP 端到端可运行，从 start 到 DONE

**预期代码量**：~400–600 行 TS + ~1500 行 Markdown

---

## 6. 依赖关系图

```
Issue 001 (Spike)
    │
    ▼
Issue 002 (MCP Bridge)
    │
    ├──────────────┐
    ▼              ▼
Issue 003        Issue 004
(assess_lighting) (map_atmosphere + check_dimension)
    │              │
    └──────┬───────┘
           ▼
    Issue 005 (Workflow)
           │
           ▼
    Issue 006 (Polish + Docs)
```

003 和 004 可以部分并行（003 做 Vision 管线时，004 可以做 `map_atmosphere` 的 UE 数据采集部分——不依赖 Vision）。

---

## 7. 时间线

| Issue | 预计时长 | 累计 | 关键风险 |
|:--:|:--:|:--:|------|
| 001 | 2–3 天 | 3 天 | `@modelcontextprotocol/sdk` 与 UE 5.8 MCP 实现的兼容性 |
| 002 | 1–2 周 | 2 周 | JSON Schema 复杂构造（oneOf + $ref 嵌套）的 TypeBox 转换 |
| 003 | 1–2 周 | 4 周 | Vision API 稳定性、Vision rating 一致性 |
| 004 | 1 周 | 5 周 | whitelist 覆盖率 |
| 005 | 1–2 周 | 7 周 | 状态机边界 case（UE 重连后状态恢复） |
| 006 | 1 周 | 8 周 | — |

**总计**：~8 周 solo 开发

---

## 8. 配置与环境变量

### 8.1 API Key 说明

扩展涉及 **两个独立的 API endpoint**：

| 用途 | Provider | 认证方式 | 说明 |
|------|---------|---------|------|
| **文本对话** (Agent 推理、调参决策) | Pi Agent 默认模型 | Pi 原生 `auth.json` / 环境变量 | 用户在 Pi 启动时已配置。扩展不管理此 key |
| **视觉分析** (截图评估、氛围判断) | Vision API (Claude/GPT/其他) | 独立 API key，通过环境变量传入 | 可与文本模型不同。支持跨 provider |

**设计原则**：Vision 调用使用 `streamSimple()` 的独立调用模式（[06-tools-and-skills.md](../Pi-migration-docs/Pi-Docs/06-tools-and-skills.md#58-streamsimple-vs-agent-使用的区别)），不经过 Agent 循环。因此需要一个独立的 API key，允许用户为 Vision 选择与文本对话不同的模型/provider。

### 8.2 Vision Auth 文件（推荐）

Vision API key 存储在 `~/.pi/agent/vision-auth.json`，与 Pi 文本模型 key 的 `auth.json` 平行管理。

**文件路径**：`~/.pi/agent/vision-auth.json`

**文件格式**：
```json
{
  "apiKey": "sk-ant-api03-...",
  "baseUrl": "https://api.anthropic.com",
  "modelId": "claude-sonnet-5-20251001"
}
```

三个字段中只有 `apiKey` 是必需的。`baseUrl` 和 `modelId` 有默认值。

### 8.3 环境变量（覆盖用）

以下环境变量会覆盖 `vision-auth.json` 中的同名配置：

| 变量 | 覆盖字段 | 默认值 |
|------|---------|------|
| `VISION_API_KEY` | `apiKey` | — |
| `VISION_API_BASE_URL` | `baseUrl` | `https://api.anthropic.com` |
| `VISION_MODEL_ID` | `modelId` | `claude-sonnet-5-20251001` |
| `VISION_MAX_TOKENS` | — (仅环境变量) | `3000` |
| `UE_MCP_URL` | — (仅环境变量) | `http://localhost:8000/mcp` |
| `UE_MCP_TIMEOUT_MS` | — (仅环境变量) | `60000` |
| `UE_MCP_RECONNECT_MAX` | — (仅环境变量) | `3` |

### 8.4 配置加载优先级

```
1. process.env.VISION_API_KEY        ← 环境变量 (最高优先级)
2. ~/.pi/agent/vision-auth.json      ← 持久化文件 (推荐)
3. 默认值 (Anthropic 原生端点)
```

---

## 9. 不做的事项（明确排除）

1. **State Cache (WorldState / ActorSnapshot)**：当前状态随时通过 `get_properties` 当场获取。不维护内存 actor 状态缓存
2. **L2 Readback 拦截器**：不在扩展中做写后自动读回验证。UE 工具的返回值已包含操作结果
3. **LevelPersistenceToolset 集成**：不依赖 UE 侧插件的 fingerprint/dirty/save 工具
4. **Vision Session 持久化**：不跨 Session 保存 Vision 分析历史。不做截图复用超过 30s
5. **多语言/多模型支持**：仅支持 Vision Vision API + Pi 默认文本模型。不实现多 provider 路由
6. **TUI 自定义组件**：不开发 Pi TUI 层的光照专用 UI 组件
7. **自动化测试框架集成**：不在本次 PRD 范围内。测试以手动端到端 + issue 验证标准为准

---

## 10. 开发红线

1. **工具是纯函数**：三个自研工具（map_atmosphere, assess_lighting, check_dimension）不读扩展内部状态。所有输入由 LLM 通过参数传入，所有输出通过工具返回 JSON
2. **工作流规则在事件层**：Phase/Tier/防呆/停止条件全部在 `tool_call` + `tool_result` + `before_agent_start` 事件 handler 中实现，不侵入工具代码
3. **不引入新依赖（超出计划）**：依赖列表为 `@modelcontextprotocol/sdk`、`sharp`（图片处理）、`typebox`（Pi 已有）。仅当必要且现有依赖无法覆盖时才加
4. **UE 是世界状态唯一权威**：不缓存 actor 状态。每次需要时调 UE 工具获取最新值
5. **禁止 Vision 模型输出执行指令**：Vision prompt 只要求输出 rating + description。不要求输出"应该调哪个参数"——那是 LLM 的事
