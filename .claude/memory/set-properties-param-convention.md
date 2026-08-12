---
name: set-properties-param-convention
description: set_properties 对常规组件用 properties (object)，对 PPV Settings struct 用 values (JSON 字符串)，两种路径不可互换
metadata:
  type: convention
---

`toolset_registry.toolsets.core.object.ObjectTools.set_properties` 有两个参数路径，使用规则取决于目标的类型：

| 目标类型 | 参数 | 示例 |
|------|------|------|
| 常规组件属性 (DirectionalLight, SkyLight, SkyAtmosphere, Fog) | `properties` (object) | `{ properties: { intensity: 10, lightColor: {r:1,g:0.9,b:0.8,a:1} } }` |
| PPV Settings 子结构 (FPostProcessSettings) | `values` (JSON 字符串) | `{ values: '{"settings": {"WhiteTemp": 6500, ...}}' }` |

**Why**: 常规组件的属性是 UPROPERTY 暴露的顶层字段，MCP 工具可直接按名存取。PostProcessVolume 的 color grading 参数嵌套在 `Settings` (FPostProcessSettings) 子结构中——这是一个 UE struct 类型，必须序列化为 JSON 字符串走 `values` 通道整体写回，不能逐字段 `properties` 写入。

**How to apply**:
1. 写 DirectionalLight/SkyLight/SkyAtmosphere/Fog 属性 → `properties: { key: value }`
2. 写 PostProcessVolume Settings → 三步流程：`get_properties(["settings"])` 读取完整 struct → 内存中修改目标字段 + `bOverride_*` → `values: JSON.stringify({ settings: modified })` 写回
3. 如果 set_properties 不报错但值不变 → 检查是否用了错误的参数名（properties vs values）

**关联**: [[ppv-set-properties-struct]], [[ue-mcp-tool-naming]]
