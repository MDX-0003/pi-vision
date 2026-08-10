# Handoff — Issue 008 预设系统设计讨论

**日期**: 2026-08-10
**状态**: 设计中，待解决描述相似度方案
**PRD**: [docs/issue-008-preset-system.md](../issue-008-preset-system.md)

---

## 1. 已定稿的设计

### 1.1 闭环流程

```
调参完成 (用户确认满意)
    │
    ▼
save_preset(name, description, reference_path)
    │  ├── 拷贝参考图 → ~/.pi/agent/presets/<name>/<original_filename>
    │  ├── 快照场景 5 类氛围组件当前属性
    │  ├── 记录 8 维 atmosphere_signature (来自最后一次 assess_lighting)
    │  └── 写入 ~/.pi/agent/presets/<name>/preset.json
    │
    ▼
下次输入新参考图 → map_atmosphere + assess_lighting 完成
    │
    ▼
匹配阶段 → 计算参考图与每条预设的相似度
    │  ├── Gate 1: 描述文本相似度 (当前卡点)
    │  └── Gate 2: 8 维 rating 余弦相似度 >= 0.85
    │
    ▼
Gate 1+2 都通过的预设注入 before_agent_start (top-3)
    │
    ▼
LLM 自主决定是否调 load_preset(name)
    │  ├── 批量 set_properties + set_actor_transform
    │  └── 更新 _activeReferencePath → 后续 assess/check 自动用预设参考图
```

### 1.2 预设存储结构

```
~/.pi/agent/presets/
├── golden-hour-sunset/
│   ├── preset.json   ← 氛围签名 + 组件属性快照
│   └── sunset_beach.png
├── purple-dusk/
│   ├── preset.json
│   └── purple_dusk_ref.png
```

每条 preset.json 包含：
- `name` — 预设名称
- `description` — LLM 写的场景描述文本
- `atmosphere_signature` — 8 维 { rating: 1-5, desc: "..." }
- `reference_image` — 参考图副本文件名
- `reference_original_path` — 原始路径 (调试追溯)
- `actors` — 5 类氛围组件当前属性快照
- `postprocess_reset` — true/false

### 1.3 快照范围

| 组件类型 | 快照内容 |
|------|------|
| DirectionalLight | LightColor, Intensity, Temperature, LightSourceAngle + transform (rotation) |
| SkyLight | LightColor, Intensity |
| SkyAtmosphere | MieScatteringScale, MieScattering, MieExponentialDistribution, RayleighScatteringScale |
| ExponentialHeightFog | FogDensity, FogHeightFalloff, FogInscatteringLuminance, DirectionalInscatteringExponent |
| VolumetricCloud | LayerBottomAltitude, LayerHeight, bVisible |

PostProcessVolume 不存属性——只存 `postprocess_reset: true` 标记。

### 1.4 四个新工具

| 工具 | 参数 | 行为 |
|------|------|------|
| `save_preset` | name, description, reference_path | 快照场景 + 拷贝图片 → 写入子目录 |
| `list_presets` | — | 列出所有预设 (name, description, atmosphere_signature, reference_image) |
| `load_preset` | name | 批量 apply + 更新 _activeReferencePath |
| `delete_preset` | name | 删除整个子目录 |

### 1.5 边界条件

- Actor 缺失 → 跳过 + 报告，不阻断
- 属性部分失败 → 继续其他组件，汇总失败项
- 预设文件损坏 → 加载时跳过，list_presets 标记
- 同名预设覆盖 → 要求用户确认
- 不自动应用预设 — LLM 始终需要主动调 load_preset
- 不跨 UE 项目 — actor refPath 绑定项目名

### 1.6 模块拆分

```
packages/ue-harness/src/presets/
├── types.ts      — PresetEntry, PresetActor, PresetMatch
├── store.ts      — CRUD (~/.pi/agent/presets/<name>/)
├── capture.ts    — capturePresetState()
├── apply.ts      — applyPreset()
├── match.ts      — findMatchingPresets() — 当前卡点
└── tools.ts      — 4 个预设工具定义
```

---

## 2. 当前卡点：描述相似度

### 2.1 问题

`atmosphere_signature` 的 8 维 rating 反映的是**预设 vs 预设自己的参考图**的差距，不是**预设参考图 vs 当前参考图**的差距。rating 向量相似度高 ≠ 两张参考图描述的是同类型场景。

因此需要 Gate 1——描述文本相似度——来判断"场景类型是否一致"（海滩夕阳 vs 城市夜景）。

### 2.2 谁来判断

| 方案 | 可行性 |
|------|:--:|
| 代码做描述相似度 | ✅ 应该做（Gate 1 初筛，过滤明显不匹配的） |
| LLM 看预设列表后自行判断 | ✅ 应该做（Gate 1 筛选后的候选，LLM 读描述决定是否加载） |
| 纯 LLM 判断 | ❌ 预设库到几十条时，全量注入 before_agent_start 会撑爆上下文 |

结论：**两层都要。** 代码先筛（把 50 条预设缩到 top-3），LLM 再判（从 3 条中选或全部跳过）。

### 2.3 代码级文本相似度方案对比

| 方案 | 原理 | 优点 | 缺点 | 行数 |
|------|------|------|------|:--:|
| **Jaccard** | 词级交集/并集 | 零依赖，10行，阈值直观 | 语义盲，"sunset"≠"dusk" | ~10 |
| **BM25** | TF-IDF 加权检索 | 工业标准，比 Jaccard 聪明，IDF 降权常见词 | 需要词汇表统计，~60行 | ~60 |
| **Embedding** | ONNX 模型向量化 + 余弦 | 真正语义，"sunset"≈"dusk" | 需要模型文件，增启动时间 | ~40+模型 |
| **N-gram Dice** | 字符级 2-gram 重叠 | 对拼写鲁棒，20行 | 精度介于 Jaccard 和 BM25 | ~20 |

**当前倾向**: BM25（零依赖 + 明显优于 Jaccard + 预设库规模下足够）。

### 2.4 待决定

1. 选哪个文本相似度方案？（BM25？先 Jaccard 快速落地再升级？）
2. Gate 1 的阈值定为多少？
3. 是否保留 Gate 2（8 维余弦）还是纯靠描述匹配？
   - 当前观点：两 Gate 都保留——Gate 1 筛场景类型，Gate 2 筛氛围质量，只有两个都过的预设才暴露给 LLM

---

## 3. 相关 Commit

| Commit | 内容 |
|------|------|
| `63fecea` | Issue 008 初始 PRD |
| `3844bf7` | 去掉 description（后被推翻） |
| `d92705f` | 恢复 description + 双门控匹配 |
