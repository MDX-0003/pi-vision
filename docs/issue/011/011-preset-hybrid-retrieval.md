# Issue 011 — 预设混合检索：ONNX Embedding + BM25 + RRF 融合

**状态**: Draft
**依赖**: 010a 已完成（TagScorer 接口 + Jaccard 匹配 + PresetMatch 类型）
**Handoff**: [docs/handoff/0812-preset-matching-future.md](../../handoff/0812-preset-matching-future.md)

---

## 动机

当前 `matchPresetsByTags` 只做 Jaccard 标签重叠——参考图标签与目标场景的相关性完全无法捕捉（"ocean_horizon" vs "forest_mountain" 都是 0 分）。需要升级为混合检索：BM25 捕捉关键词，ONNX embedding 捕捉语义，RRF 融合排名。

Vision re-rank（Phase 2）不在此 issue 范围，但接口预留。

---

## 子任务

### 1. 接口升级：`matchPresetsByTags` → `matchPresets`

#### 1.1 新增类型

```typescript
// match.ts

/** 参考图查询（来自 assess_lighting Stage1 的 analyzeAndTag） */
interface PresetQuery {
  tags: string[];       // 开放式标签，0-5 个
  description: string;  // Vision 生成的中文描述
}

/** 单个打分器。同步返回 0-1 分数。快（<10ms），不调 API。 */
type PresetScorer = (query: PresetQuery, preset: PresetEntry) => number;
```

#### 1.2 替换函数签名

```typescript
// Before
export function matchPresetsByTags(
  queryTags: string[],
  presets: PresetEntry[],
  options?: { scorer?: TagScorer; topN?: number },
): PresetMatch[]

// After
export function matchPresets(
  query: PresetQuery,
  presets: PresetEntry[],
  options?: { topN?: number },
): PresetMatch[]
```

`topN` 默认 5（给 Vision re-rank 用；现在没有 re-rank 时即最终返回 top-5）。

#### 1.3 内部：融合三种 scorer

```typescript
function matchPresets(query: PresetQuery, presets: PresetEntry[], options?: { topN?: number }): PresetMatch[] {
  const topN = options?.topN ?? 5;
  const scorers = getActiveScorers(); // 全局单例

  const results: PresetMatch[] = [];
  for (const preset of presets) {
    // 每个 scorer 独立打分
    const scores: Record<string, number> = {};
    for (const [name, scorer] of Object.entries(scorers)) {
      scores[name] = scorer(query, preset);
    }
    // RRF 融合
    // ...
  }
  // 排序 → topN
}
```

### 2. ONNX Embedding Scorer（首要子任务）

#### 2.1 模型

- **模型**: `all-MiniLM-L6-v2`（sentence-transformers）
- **ONNX 大小**: ~23MB
- **输出**: 384-dim float32 向量
- **最大 tokens**: 256（preset 的 name+desc+tags 不会超过）
- **推理延迟**: <10ms（node onnxruntime，首次调后稳定在 ~3-5ms）

#### 2.2 模型获取与缓存

```
首次运行:
  download from HuggingFace Hub (Xenova/all-MiniLM-L6-v2, ONNX version)
  → 保存到 ~/.pi/models/all-MiniLM-L6-v2/

后续运行:
  读本地缓存 → 加载到 onnxruntime.InferenceSession
```

使用 `@xenova/transformers` 的 ONNX 导出（或直接从 HuggingFace `optimum` 导出下载）。

或者更简单的方式：使用 `@huggingface/transformers`（JavaScript）的 ONNX 后端。它自动处理下载和缓存。但包体积较大。

**推荐方案**：使用 `@xenova/transformers`（已废弃但稳定）或直接通过 `onnxruntime-node` + 预处理 tokenizer。实际的轻量方案是使用 `transformer.js` 风格的最小化实现。

**最简方案**（推荐 for v1）：
1. 依赖 `onnxruntime-node`（~15MB 原生扩展）
2. Tokenizer 自实现（WordPiece，~50 行，或从 `@xenova/transformers` 提取独立 tokenizer）
3. 模型文件从 HuggingFace 手动下载一次，放到 `~/.pi/models/`

**待确认**：
- `onnxruntime-node` 在 Windows Node v22 上的原生模块编译（已有预编译二进制，但需验证）
- Tokenizer 实现复杂度：WordPiece tokenizer 的 vocab 文件 + 自实现 ≈ 100 行

#### 2.3 EmbeddingService 单例

```typescript
// src/presets/embedding.ts

interface EmbeddingCache {
  vectors: Float32Array[];  // 每个 preset 的 384-dim 向量
  hash: string;             // presets 内容的 hash，检测失效
}

class EmbeddingService {
  private session: onnxruntime.InferenceSession | null = null;
  private cache: EmbeddingCache | null = null;

  /** session_start 时调用 */
  async initialize(modelPath: string): Promise<void>;

  /** 确保 cache 与当前 presets 同步 */
  async syncCache(presets: PresetEntry[]): Promise<void>;

  /** 创建 scorer 函数 */
  createScorer(): PresetScorer;
  // 返回 (query, preset) => cosineSimilarity(queryVec, cachedVec)
}
```

Scorer 工作流程：
1. 将 `query.description + " " + query.tags.join(" ")` 编码为 384-dim 向量（computeQueryEmbedding）
2. 从 cache 中取对应 preset 的向量
3. 计算 cosine similarity → 0-1

**关键优化**：query embedding 在一次 `matchPresets` 调用中只计算一次，然后对所有 preset 复用（不是每个 preset 重新计算 query 向量）。

### 3. BM25 Scorer

自实现，无外部依赖。

```typescript
// src/presets/bm25.ts

class BM25Index {
  private k1 = 1.5;
  private b = 0.75;
  private docCount = 0;
  private avgDocLength = 0;
  private idf: Map<string, number> = new Map();
  private docLengths: number[] = [];
  private termFreqs: Map<string, number>[] = [];

  /** 从 PresetEntry[] 建索引 */
  buildIndex(presets: PresetEntry[]): void;

  /** 创建 scorer 函数 */
  createScorer(): PresetScorer;
}
```

文本分词：简单的 whitespace + 英文 stem（小写、去标点）。中文？当前 preset 标签以英文为主，暂不处理中文分词。

### 4. RRF（Reciprocal Rank Fusion）融合

```typescript
// src/presets/match.ts

function reciprocalRankFusion(
  scoredPresets: Map<number, Record<string, number>>, // presetIndex → { jaccard, bm25, embedding }
  k = 60,
): number {
  let rrf = 0;
  for (const [name, score] of Object.entries(scoredPresets)) {
    // 按 score 降序得到该 scorer 中的排名
    // rrf += 1 / (k + rank)
  }
  return rrf;
}
```

当某个 scorer 未启用时（如 embedding 尚未初始化），只用活跃的 scorer 做 RRF。

### 5. 缩略图保存（save_preset 附带）

`save_preset` 保存 preset 时同时写一个 `thumbnail.png`（256px 宽等比例缩放）：

```typescript
// tools.ts executeSavePreset 中
// 存在 capture.filePath 的原图 → sharp 或 canvas resize → thumbnail.png
```

可以使用 Node.js 原生方式（`canvas` 包或纯 buffer resize）或简单的：再截一张低分辨率图（`captureViewport(ueClient, 0.2)`）。后者最简单但多一次 MCP 调用。

**推荐**：`captureViewport` 再加一个参数 `resolutionMultiplier`，或者单独截一次低分辨率。

实际上 UE 的 `CaptureViewportImage` 接受 `ResolutionMultiplier`，传 0.2 即为 256px 级别。最简单。

缩略图保存路径：`~/.pi/agent/presets/<name>/thumbnail.png`。

### 6. 调用方适配（index.ts）— 注入方式 = tool_result 插入

**关键决策**：preset 建议通过 `tool_result` 事件**追加到 assess_lighting 的返回结果里**，而不是在 `before_agent_start` 注入 systemPrompt。

**理由**：
- 时机准确：assess_lighting 完成后，LLM 正在决策"下一步调什么"，立即看到建议
- `before_agent_start` 是"每个 turn 开始"粒度，若 LLM 在 assess 后不停下（继续调参），建议会延迟到下一个 turn，失去"起点"意义
- `tool_result` 事件支持修改 content（`ToolResultEventResult.content`），已从 `pi-coding-agent` 类型定义确认

**时机**：只在**第一次 assess_lighting** 后（`assessCount === 1`），之后不再出现。用 `assessCount === 1` 精确判断，不需要计数器/缓存——`onAssessLighting` 之后 assessCount 恰好递增到 1。

```typescript
// index.ts — tool_result 事件
pi.on("tool_result", (event: any) => {
    if (event.toolName === "assess_lighting") {
        try {
            const text = event.content?.[0]?.text || "";
            const data = JSON.parse(text) as AssessLightingResult;

            if (data.success) {
                // ... 现有逻辑：onAssessLighting + lastTagResult 更新

                // 只在第一次 assess 后匹配并追加 preset 建议
                if (data.tagResult && _phaseState.assessCount === 1) {
                    const presets = loadAllPresets();
                    if (presets.length > 0) {
                        const matches = matchPresets(
                            { tags: data.tagResult.tags, description: data.tagResult.description },
                            presets,
                            { topN: 5 },
                        );
                        if (matches.length > 0) {
                            const suggestion = buildPresetSuggestion(matches);
                            return {
                                content: [
                                    ...event.content,
                                    { type: "text", text: suggestion },
                                ],
                            };
                        }
                    }
                }
            }
        } catch { /* ignore */ }
    }
    return undefined;  // 不修改
});
```

LLM 在 assess_lighting 返回里看到两个 text block：JSON 诊断结果 + preset 建议文本。

**未来扩展点**（Phase 2 Vision re-rank）：在 `matchPresets` 得到 top-5 之后、`buildPresetSuggestion` 之前，插入 Vision 读缩略图的步骤，得到最终 top-2。

**文案要求**：`buildPresetSuggestion` 需明确告诉 LLM "此建议仅在本次 assess 后出现一次，不会重复"。

### 7. session_start 初始化

```typescript
// index.ts session_start
await embeddingService.initialize(modelPath);
await embeddingService.syncCache(presets);
bm25Index.buildIndex(presets);
```

`save_preset` / `delete_preset` 后同步更新 cache（或简单标记失效，下次匹配时重建）。

**缓存层次**（仅 Preset 侧，无 Query 侧）：
- **Preset 侧**：所有 preset 的 embedding 向量，失效条件 = preset 增删，位置在 `EmbeddingService` 内部（§2.3）
- **Query 侧**：不需要——因为匹配只在第一次 assess 后发生一次，无重复计算

### 8. 存量测试适配

| 文件 | 改动 |
|------|------|
| `test/presets-008c-match.mjs` | 重写：`matchPresets(query, presets)` 签名；Jaccard 默认可运行（无需 ONNX） |
| `test/presets-010c-capture.test.mjs` | 不变 |
| 新增 `test/presets-011-bm25.mjs` | BM25 索引构建 + 基本打分测试 |

---

## 确认项（2026-08-12 已验证）

| 项目 | 状态 | 说明 |
|------|:--:|------|
| `onnxruntime-node` 在 win32-x64 Node v22 原生编译 | ✅ | `onnxruntime-node@1.27.0` 已装并加载成功 |
| Tokenizer 自实现 | ✅ | 手写 WordPiece 已验证：相似度 golden-hour 组 0.856，异义组 0.423 |
| 模型下载 | ✅ | `model.onnx`（90MB）+ `tokenizer.json` + `config.json` 已存 `~/.pi/models/all-MiniLM-L6-v2/` |
| 推理性能 | ✅ | 模型加载 115ms（一次性），encode 4.8ms/次 |
| 缩略图截图 | ✅ | `captureViewport(caller, 0.2)` 即可 |

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src/presets/match.ts` | 重写：`matchPresets(query, presets, opts)` + RRF 融合 |
| `src/presets/embedding.ts` | **新建**：EmbeddingService 单例 + ONNX 加载 + embedding scorer |
| `src/presets/bm25.ts` | **新建**：BM25Index 类 + BM25 scorer |
| `src/presets/types.ts` | 新增 `PresetQuery` 接口 |
| `src/presets/tools.ts` | save_preset 追加 thumbnail 截图 |
| `src/index.ts` | 适配 `matchPresets` 调用 + session_start 初始化 embedding/bm25 |
| 新增依赖 | `onnxruntime-node`（devDependency） |
| `test/presets-008c-match.mjs` | 重写 |
| `test/presets-011-bm25.mjs` | **新建** |
| `test/presets-011-embedding.mjs` | **新建**（需前置下载模型） |

---

## 非本期范围（延期至后续 Issue）

- Vision re-rank（Phase 2）：第一次 assess 后拿到 top-5 → Vision 读缩略图 → 返回 top-2 最终建议，替换当前的纯检索 top-5
