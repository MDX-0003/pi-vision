---
name: session-export-format
description: Pi session export HTML 结构 — systemPrompt 在根层级，不存储每轮中间版本；诊断注入是否生效需从 systemPrompt 尾部检查
metadata:
  type: reference
---

Pi session export HTML 的结构：

```json
{
  "systemPrompt": "<根层级，仅存储最后一轮的完整 system prompt>",
  "header": { "type": "session", "version": 3, "id": "...", ... },
  "entries": [
    { "type": "message", "id": "...", "message": { "role": "user|assistant|toolResult", "content": [...] } }
  ]
}
```

**关键发现**：
- `systemPrompt` 在 JSON **根层级**，不在 entry 内部
- 只存储 **最后一轮** 的 system prompt，历史中间版本不可追溯
- User message 的 `content` 只包含用户输入的原始文本，不包含注入的 system prompt

**诊断注入是否生效的方法**：
```python
sp = data.get("systemPrompt", "")
# 在尾部搜索注入标记
has_injection = "当前阶段" in sp[-3000:] or "定量趋势" in sp[-3000:]
```

**Why**: Pi 的 `before_agent_start` handler 通过 `return { systemPrompt: event.systemPrompt + appendix }` 注入，Pi 在发送 API 请求前修改 system prompt。Session export 捕获的是发送给 API 的最终 system prompt，但只保留最后一份。

**How to apply**: 排查"注入是否生效"时，不要搜 entry 内部的 user message content，搜根层级的 `systemPrompt`。要追溯历史注入内容，需在 extension 中自行打 log。
