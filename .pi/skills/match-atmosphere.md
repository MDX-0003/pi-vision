---
name: match-atmosphere
description: 根据参考图匹配 UE 场景的光照氛围。使用 assess_lighting 做全维度评估、check_dimension 做单维度验证。
triggers:
  - 参考图
  - 氛围匹配
  - match atmosphere
  - 调光
  - 光照匹配
  - 按参考图调
---

# 参考图光照氛围匹配 SOP

## 前置条件

- UE 编辑器已打开目标关卡
- 参考图文件在本地磁盘上

## 标准流程

### Phase 1: 初始化

1. 调 `map_atmosphere()` — 发现场景中所有可调的光照参数
2. 调 `assess_lighting(reference_path)` — 获取参考图氛围 + 每维度 gap 报告

### Phase 2: 逐 Tier 调整

系统会根据 `assess_lighting` 的返回自动控制调参顺序。你不需要手动判断应该先调什么——工具会被自动阻止：

**Tier 1 — 核心光照**（优先调整）：
- DirectionalLight: lightColor, intensity, temperature, lightSourceAngle
- SkyLight: lightColor, intensity

**Tier 2 — 大气效果**（Tier 1 完成后才能调）：
- SkyAtmosphere: rayleighScatteringColor, mieScatteringColor, groundAlbedo
- ExponentialHeightFog: fogDensity, fogHeightFalloff, fogInscatteringColor
- VolumetricCloud: layerBottomAltitude, layerHeight

**Tier 3 — 后期处理**（Tier 1-2 完成后才能调）：
- PostProcessVolume: whiteTemp, colorSaturation, colorContrast, colorGamma

### Phase 3: 验证

每次调参后，调 `check_dimension(reference_path, dimension)` 验证方向：
- closer → 方向正确，继续
- similar → 方向对但幅度不够，加大
- further → 方向错误，回退

一个 Tier 的所有维度 gap=minor 后，调 `assess_lighting(reference_path)` 进入下一个 Tier。

## 重要规则

1. 不要手动截图 — `assess_lighting` 和 `check_dimension` 内部会自动截图
2. 在 SETUP 和 POSTPROCESS_SETUP 阶段截图会被自动阻止
3. 跨 Tier 调参会自动被阻止
4. 如果 `artificiality.detected = true` — 说明你在用后期滤镜而非真实光源 → 回退 PostProcess 到默认值
