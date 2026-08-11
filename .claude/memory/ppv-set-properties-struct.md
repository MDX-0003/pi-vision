---
name: ppv-set-properties-struct
description: PostProcessVolume 的 Settings 是嵌套 struct，不能直接用 properties object 写入，必须 values JSON 字符串 + bOverride + 整体写回
metadata:
  type: gotcha
---

PostProcessVolume 的 color grading 参数（WhiteTemp, ColorSaturation 等）嵌套在 `Settings` 子结构（`FPostProcessSettings`）中，**不能**像 DirectionalLight/SkyLight 那样直接在 actor refPath 上用 `properties` object 设置单个属性。

**正确的 PPV set 方式**:
1. `get_properties({ instance: { refPath }, properties: ["settings"] })` 读取完整 settings struct
2. 在内存中修改目标字段 + 设置对应的 `bOverride_*` 标志为 `true`
3. `set_properties({ instance: { refPath }, values: JSON.stringify({ settings: modified }) })` 以 values JSON 字符串整体写回

**关键差异 vs 常规组件**:
- 参数名: PPV 用 `values` (JSON 字符串)，常规组件用 `properties` (object)
- 层级: PPV 属性在 `settings` 子结构下，常规组件属性直接在 component 顶层
- bOverride: PPV 必须设置 `bOverride_<PropertyName>: true`，否则 UE 忽略值

**Why**: UE 的 `FPostProcessSettings` 是一个庞大的嵌套 struct（100+ 字段），MCP 工具对 struct 类型的写入必须序列化为 JSON 字符串走 `values` 通道，不能走 `properties` object 通道。`bOverride_*` 是 UE 后处理系统的机制——只有被标记为 override 的字段才会在 blending 时被应用。

**How to apply**: 任何时候需要修改 PostProcessVolume 的 color grading 参数，都用此三步流程：读 settings → 改字段+bOverride → values JSON 写回。直接 set_properties 单属性会静默失败（不报错，但值不生效）。

**验证脚本**: `E:/Programs/UE_Project_58/MCP/Test/ppv_test2.py`（已验证 struct write-back 可行）
`E:/Programs/UE_Project_58/MCP/Test/test_ppv_direct.py`（已验证 bOverride + WhiteTemp=7777 write-back 成功）
