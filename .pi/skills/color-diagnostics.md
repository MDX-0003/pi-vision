---
name: color-diagnostics
description: 诊断画面色调异常。7种色调偏移类型 + 根因分析 + 优先处理建议。
triggers:
  - 颜色不对
  - 偏色
  - 色调异常
  - color cast
  - 画面偏绿
  - 画面偏蓝
  - 画面偏紫
  - 为什么颜色不对
---

# 颜色诊断决策树

当画面出现不自然的色调偏移时，按以下流程诊断。

## 步骤 1: 确认症状

先用 `assess_lighting(reference_path)` 获取当前状态。重点关注：
- `color_cast` 维度是否有 gap
- `artificiality.detected` 是否为 true

## 步骤 2: 根因分类

### 类型 A: 全局偏蓝/偏冷

**症状**: 整个画面有一层蓝色调，尤其是中性和白色区域
**根因**:
1. DirectionalLight.LightColor 蓝色分量过高
2. SkyLight.LightColor 偏蓝
3. PostProcessVolume 的 whiteTemp 过低 (<6000K)

**优先检查顺序**: DirectionalLight → SkyLight → PostProcessVolume

### 类型 B: 全局偏橙/偏暖过度

**症状**: 画面过于橙黄，不自然
**根因**:
1. PostProcessVolume 的 whiteTemp 过高 + colorSaturation > 1.0
2. DirectionalLight.LightColor 红色分量过高
3. 人工后期感 (artificiality.detected = true)

**优先检查顺序**:
- 如果 artificiality = true → 先回退 PostProcess 到默认值
- 如果 artificiality = false → 先调 DirectionalLight

### 类型 C: 全局偏绿

**症状**: 画面有一层绿色调
**根因**:
1. PostProcessVolume 的 colorGradingIntensity 过高且颜色偏绿
2. SkyAtmosphere 的 rayleighScatteringColor 偏绿
3. ExponentialHeightFog 的 fogInscatteringColor 偏绿

**优先检查**: PostProcessVolume → SkyAtmosphere → ExponentialHeightFog

### 类型 D: 全局偏紫/偏品红

**症状**: 画面有一层紫色调
**根因**:
1. PostProcessVolume 的 sceneFringeIntensity 过高
2. SkyAtmosphere 的 mieScatteringColor 偏紫
3. 不自然的 postProcess 滤镜组合

**优先检查**: PostProcessVolume → SkyAtmosphere

### 类型 E: 暗部偏蓝

**症状**: 暗部区域偏蓝，但亮部正常
**根因**:
1. SkyLight.LightColor 蓝色分量高（SkyLight 主要影响间接光照/暗部）
2. ExponentialHeightFog 的 directionalInscatteringColor 偏蓝

**优先检查**: SkyLight → ExponentialHeightFog

### 类型 F: 亮部偏黄

**症状**: 只有亮部偏黄，暗部色调正常
**根因**:
1. DirectionalLight.LightColor 红色/绿色分量偏高
2. DirectionalLight.temperature 过高

**优先检查**: DirectionalLight

### 类型 G: 饱和度异常

**症状**: 画面过饱和或灰蒙蒙
**根因**:
1. 过饱和 → PostProcessVolume.colorSaturation > 1.5
2. 灰蒙蒙 → PostProcessVolume.colorContrast < 0.8 或 colorGamma < 0.8

**优先检查**: PostProcessVolume

## 步骤 3: 验证修复

调整后调 `check_dimension(reference_path, "color_cast")` 确认方向。
如果 artificiality 仍然检测到 → 必须回退 PostProcess 到默认值 + 从 Tier1 重新开始。
