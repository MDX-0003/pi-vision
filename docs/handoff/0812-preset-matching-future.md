# Handoff: 预设匹配 — 当前接口与未来 embedding+BM25 拓展规划

**日期**: 2026-08-12
**来源**: Issue 010a 后续讨论
**关联 Issue**: [Issue 011](../issue/011/011-preset-hybrid-retrieval.md)
**决策**: 以下已与用户确认（2026-08-12）:
- `matchPresetsByTags` 直接重写为 `matchPresets`，不包装 adapter
- 本地 ONNX 推理（all-MiniLM-L6-v2），<10ms，`PresetScorer` 保持同步签名
- BM25 与 embedding 并行→RRF 融合，非串行
- Vision re-rank: 5→2（非 10→3），Phase 2 延期
- save_preset 同时保存 256px thumbnail
- 本 handoff 第 4 节的 `PresetRetriever` 异步接口方案已被否决——用户要求同步

---

## 1. 当前架构

### 1.1 数据流

```
assess_lighting(reference_path)
  │
  ├─ Stage1 并行
  │   ├─ computeMetrics(ref, capture)    → QuantitativeReport
  │   └─ analyzeAndTag(vision, ref)       → TagResult { description, tags: string[] }
  │
  └─ Stage2
      └─ Vision 综合定量+双图            → AssessLightingResult { analysis[], overall }
          │
          ▼ tagResult 存入 _phaseState.lastTagResult (index.ts:333)

before_agent_start 注入 (index.ts:343-368)
  │
  ├─ if TUNING && lastTagResult && assessCount <= 2:
  │     matchPresetsByTags(lastTagResult.tags, presets)
  │       └─ jaccardTagScore(query, preset) per preset     [match.ts]
  │       → PresetMatch[] (score>0, top-10)
  │     buildPresetSuggestion(matches)                      [injections.ts]
  │       → "## 匹配的预设\n[1] name (匹配标签: ..., 得分 0.5)\n..."
  │
  └─ buildInjectionAppendix(state, presetSuggestion)
      → 拼入 systemPrompt
```

### 1.2 核心接口

```typescript
// match.ts — 当前版本

// 标签打分函数（纯函数，同步）
export type TagScorer = (queryTags: string[], presetTags: string[]) => number;

// 当前实现：Jaccard overlap
export function jaccardTagScore(queryTags: string[], presetTags: string[]): number;

// 匹配入口
export function matchPresetsByTags(
  queryTags: string[],                     // 参考图标签
  presets: PresetEntry[],                  // 所有预设
  options?: { scorer?: TagScorer; topN?: number },
): PresetMatch[];

// 返回类型
interface PresetMatch {
  name: string;
  description: string;
  score: number;           // 0-1
  matchedTags: string[];   // 重叠的标签名
}
```

### 1.3 调用点

```typescript
// index.ts:350 — 唯一直调点
const matches = matchPresetsByTags(
  _phaseState.lastTagResult.tags,  // string[]
  presets,                         // PresetEntry[]
);
```

---

## 2. TagScorer 接口评估

### 2.1 能做什么

| 能力 | 说明 |
|------|------|
| 纯 Jaccard 标签匹配 | ✅ `jaccardTagScore` 已实现 |
| 替换为任意 `(string[], string[]) => number` | ✅ 签名兼容即可 |
| 自定义 cutoff | ✅ caller 设置 `options.topN` |

### 2.2 不能做什么（embedding 路径的障碍）

| 障碍 | 问题 | 影响 |
|------|------|------|
| **只能访问 tags，不能访问 description** | 预设的描述文本 (`PresetEntry.description`) 不在 scorer 参数中 | embedding 需要对比描述文本，不只是几个标签 |
| **只能访问 tags，不能访问 screenshot** | Vision re-rank 需要读取截图文件 | 无法在当前接口内实现 |
| **同步签名** | `(string[], string[]) => number` 不支持 async | embedding 查询通常是异步的（网络请求或本地模型推理） |
| **逐 preset 调用** | `matchPresetsByTags` 的 for 循环对每个 preset 单独调用 scorer | 批量 embedding 查询（一次请求计算所有 preset 向量）无法利用此接口 |
| **只有 score，无向量** | 返回 number，不保留中间向量 | 无法缓存 preset embedding 以复用于后续匹配 |

### 2.3 结论

**`TagScorer` 对当前的 Jaccard 方案是合适的，但对 embedding 路径过于狭窄。** 未来替换时不应尝试"实现一个 embedding 版 TagScorer"，而应升级为更高层的抽象。

---

## 3. 未来目标架构：两阶段检索

### 3.1 用户设想的完整流程

```
before_agent_start
  │
  ├─ Phase 1: 快速检索（代码层，无 Vision API）
  │   │
  │   │  输入: TagResult { description, tags }
  │   │
  │   ├─ 方案 A: BM25 文本检索
  │   │   └─ query = tags.join(" ") + " " + description
  │   │      对所有 preset 的 (name + description + tags) 建索引
  │   │      → top-10 候选
  │   │
  │   ├─ 方案 B: embedding 语义检索
  │   │   └─ 预计算每个 preset 的 text embedding（name+desc+tags）
  │   │      查询时计算 query embedding → cosine similarity → top-10
  │   │
  │   └─ 方案 C: 混合检索（推荐）
  │       └─ BM25 + embedding 融合打分（如 RRF 倒数排名融合）
  │
  ├─ Phase 2: Vision 重排序（调 Vision API，1 次调用）
  │   │
  │   │  输入: top-10 preset 的截图（多图并排或分批发给 Vision）
  │   │  prompt: "以下是 10 个预设的截图，当前参考图目标是 __，哪些预设与目标最相似？"
  │   │  → Vision 返回排序 + 分析
  │   │  → 提取 top-3
  │   │
  │   └─ buildPresetSuggestion(top3)
  │       → 注入 systemPrompt，LLM 自主决定是否 load_preset
  │
  └─ buildInjectionAppendix(state, presetSuggestion)
```

### 3.2 为什么需要两阶段

- 全量 preset 可能有 50-100 个。直接用 Vision 读 100 张图太贵（~$0.5-1/次）。
- Phase 1 快速缩小到 10 个（BM25 免费，embedding ~$0.001）。
- Phase 2 Vision 只读 10 张图（~$0.05-0.1），且每周最多触发 2 次（`assessCount <= 2`）。

---

## 4. 需要的接口升级

### 4.1 从 TagScorer → PresetRanker

```typescript
// 当前（match.ts）
export type TagScorer = (queryTags: string[], presetTags: string[]) => number;
//   ↑ 同步、tag-only、per-preset

// 未来（match.ts 新版本）
export interface PresetQuery {
  tags: string[];
  description: string;  // 参考图的自然语言描述
}

/**
 * Phase 1 检索器。
 * 输入查询 + 候选 preset 列表 → 输出排序后的 top-N 候选。
 *
 * 当前实现: JaccardTagRetriever（包装 jaccardTagScore）
 * 未来实现: HybridRetriever（BM25 + embedding + RRF 融合）
 */
export interface PresetRetriever {
  retrieve(query: PresetQuery, presets: PresetEntry[], topN: number): Promise<PresetMatch[]>;
}

// 当前实现
export class JaccardTagRetriever implements PresetRetriever {
  async retrieve(query: PresetQuery, presets: PresetEntry[], topN: number): Promise<PresetMatch[]> {
    const results: PresetMatch[] = [];
    for (const preset of presets) {
      const score = jaccardTagScore(query.tags, preset.tags);
      if (score > 0) {
        results.push({
          name: preset.name,
          description: preset.description,
          score: Math.round(score * 100) / 100,
          matchedTags: query.tags.filter(t => preset.tags.includes(t)),
        });
      }
    }
    return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, topN);
  }
}

// 未来实现（示意）
export class HybridRetriever implements PresetRetriever {
  private embedder: EmbeddingService;
  private bm25Index: BM25Index;

  async retrieve(query: PresetQuery, presets: PresetEntry[], topN: number): Promise<PresetMatch[]> {
    const queryText = `${query.description} ${query.tags.join(" ")}`;
    const bm25Scores = this.bm25Index.search(queryText, presets);
    const embedScores = await this.embedder.search(queryText, presets);
    return reciprocalRankFusion(bm25Scores, embedScores, topN);
  }
}
```

### 4.2 调用点变化（index.ts）

```typescript
// 当前
const matches = matchPresetsByTags(
  _phaseState.lastTagResult.tags,
  presets,
);

// 未来 Phase 1
const retriever = getRetriever(); // 单例，session 内复用
const candidates = await retriever.retrieve(
  {
    tags: _phaseState.lastTagResult.tags,
    description: _phaseState.lastTagResult.description,
  },
  presets,
  10,  // top-10
);

// 未来 Phase 2（仅在 candidates.length > 0 时）
const top3 = await visionRerank(visionClient, referenceScreenshotPath, candidates);
presetSuggestion = buildPresetSuggestion(top3);
```

### 4.3 Embedding 缓存策略

```typescript
/**
 * Embedding 服务的内部接口。
 * 维护 preset 的文本 embedding 缓存。
 * 当 preset 被新增/删除时缓存失效。
 */
interface EmbeddingService {
  /** 计算所有 preset 的 embedding（首次调用或缓存失效时） */
  buildIndex(presets: PresetEntry[]): Promise<void>;
  /** 查询最相似的 N 个 preset */
  search(queryText: string, presets: PresetEntry[], topN: number): Promise<PresetMatch[]>;
}
```

预设数量少（<100），embedding 向量可全部放在内存中。每次 `listAllPresets` 时做一次哈希检查决定是否重建索引。

### 4.4 BM25 索引

轻量纯 JS 实现（如 `minisearch` 或自研 ~50 行），建在 `PresetEntry` 的 `name + description + tags.join(" ")` 拼接文本上。无需持久化——每次 session_start 重建。

---

## 5. 迁移路径（向后兼容）

### Phase 0（当前，已实现）

- `TagScorer` + `jaccardTagScore` + `matchPresetsByTags`
- 保留并继续工作，作为默认检索器

### Phase 1（下一个 PR）

1. 定义 `PresetQuery`、`PresetRetriever` 接口
2. 实现 `JaccardTagRetriever`（包装当前逻辑）
3. `matchPresetsByTags` 标记为 `@deprecated`，内部委托给 `JaccardTagRetriever`
4. `index.ts` 改为调用 `retriever.retrieve(query, presets, 10)`

### Phase 2（BM25）

1. 安装或自研 BM25 实现
2. 实现 `BM25Retriever`
3. 可通过环境变量或 config 切换 `JaccardTagRetriever` / `BM25Retriever`

### Phase 3（Embedding）

1. 选择 embedding provider（可通过配置切换：openai / anthropic / local）
2. 实现 `EmbeddingService` + 缓存
3. 实现 `HybridRetriever`（BM25 + embedding RRF 融合）

### Phase 4（Vision re-rank）

1. `visionRerank()` 函数：接收 top-10 candidates + 参考截图 → 调 Vision API → 返回 top-3
2. 插入 `before_agent_start` 中 Phase 1 和 Phase 2 之间

---

## 6. 不变的部分

以下组件无论检索方式如何变化，都不需要改动：

| 组件 | 原因 |
|------|------|
| `PresetEntry` / `PresetMatch` 类型 | 输出格式稳定 |
| `buildPresetSuggestion()` | 输入仍是 `PresetMatch[]`，只改 match 字段名 |
| `analyzeAndTag()` | 始终产出 `TagResult { description, tags }` |
| `loadAllPresets()` | I/O 层不变 |
| `buildInjectionAppendix()` | 注入编排不变 |
| Phase 门控条件 (`assessCount <= 2`, `TUNING`) | 业务规则不变 |

---

## 7. 关键开放问题

1. **Embedding provider 选择**：用 Anthropic embedding API？本地模型（如 all-MiniLM-L6-v2 onnx）？需要权衡延迟（本地 ~5ms vs API ~200ms）与部署复杂度。

2. **Vision re-rank 的 prompt 设计**：10 张缩略图合并为一张大图发给 Vision？还是分批发？需要实验确定 Vision 在这个任务上的表现。

3. **Preset 截图存储格式**：当前截图是完整视口 PNG，可能 2-5MB。re-rank 时需要缩略图（256x256）以降低 Vision 成本。是否需要 save_preset 时同时保存缩略图？

4. **触发时机**：当前 `assessCount <= 2`（前两次 assess 时触发）。embedding 路径下这个门槛是否需要调整？

5. **嵌入向量持久化**：是否需要将 embedding 向量写入 `preset.json` 以跳过 next-session 的重计算？还是每次 session_start 重建（<100 preset，成本很低）？
