---
name: scene-lighting
description: 精确调整单个灯光参数。不依赖参考图，直接对现有参数做精确修改。
triggers:
  - 调整灯光
  - 修改光照
  - 调亮度
  - 调色温
  - 改变光照
---

# 场景灯光精确调整 SOP

不依赖参考图时使用此 Skill。依赖参考图时使用 `match-atmosphere` Skill。

## 标准流程

1. 了解当前场景状态：
   - `map_atmosphere()` — 看到所有可调参数及其当前值
   - 选中要调整的 Actor

2. 精确调参：
   - 用 `set_properties` 写入新值
   - 用 `get_properties` 验证写入结果

3. 视觉验证：
   - 如需视觉确认 → 调 `assess_lighting(reference_path)`（需要参考图对比才有意义）
   - 如仅需确认写入正确 → 调 `get_properties` 读回值

## 常用参考值

| 效果 | 参数 | 参考值 |
|------|------|--------|
| 暖调黄昏 | DirectionalLight.LightColor | R:1.0, G:0.7, B:0.4 |
| 冷调月光 | DirectionalLight.LightColor | R:0.5, G:0.6, B:1.0 |
| 正午日光 | DirectionalLight.LightColor | R:1.0, G:0.95, B:0.9 |
| 浓雾 | ExponentialHeightFog.fogDensity | 0.1-0.5 |
| 淡雾 | ExponentialHeightFog.fogDensity | 0.02-0.05 |
| 高对比 | PostProcessVolume.colorContrast | 1.2-1.5 |
