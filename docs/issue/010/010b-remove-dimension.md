# Issue 010b — 删除 whitelist 的 dimension 字段及关联死代码

**状态**: Draft  
**依赖**: 无（与 010a、010c 并行独立）

---

## 动机

`PropertyAnnotation.dimension` 是早期 `map_atmosphere` 工具的设计遗留——它将每个属性归入抽象维度（`brightness`, `color_temperature` 等），输出给 LLM 一个 `dimensions` 列表。

实际情况：
1. `assess_lighting`（Issue 009 串行架构）输出的是自由命名的 `aspect`，不使用这套维度分类
2. `capturePresetState` 只用 `property` 和 `componentClass` 过滤，完全不碰 `dimension`
3. `DIMENSION_LABELS` 和 `DIMENSION_TIER` 在整个项目中没有任何 import
4. `map-atmosphere.ts` 的 `_componentKeyToClass` 从未被调用

**目标**：删掉 dimension 属性及其上下游死代码，`map_atmosphere` 不再输出 dimension 归类信息。

---

## 一、atmosphere-whitelist.ts

### PropertyAnnotation 类型

```typescript
// Before
export interface PropertyAnnotation {
  property: string;
  dimension: string;
  componentClass: string;
}

// After
export interface PropertyAnnotation {
  property: string;
  componentClass: string;
}
```

### ATMOSPHERE_WHITELIST 数组

每个条目删掉 `dimension` 字段：

```typescript
// Before
export const ATMOSPHERE_WHITELIST: PropertyAnnotation[] = [
  { property: "lightColor", dimension: "color_temperature", componentClass: "DirectionalLightComponent" },
  { property: "lightColor", dimension: "brightness", componentClass: "DirectionalLightComponent" },
  { property: "intensity", dimension: "brightness", componentClass: "DirectionalLightComponent" },
  // ... 共 30 个条目，每个都有 dimension
];

// After
export const ATMOSPHERE_WHITELIST: PropertyAnnotation[] = [
  { property: "lightColor", componentClass: "DirectionalLightComponent" },
  // 注意: lightColor 出现两次（color_temperature + brightness），去重合并为一条
  { property: "intensity", componentClass: "DirectionalLightComponent" },
  // ... 去重后约 18 个条目
];
```

> **去重**：原来同一个 `(property, componentClass)` 可能因为属于不同 dimension 出现多次（如 `lightColor` 在 DirectionalLightComponent 下有两次）。去掉 dimension 后需要 `uniqBy(property + componentClass)` 合并。

### 删除

```typescript
// 整块删除
export const DIMENSION_LABELS: Record<string, string> = { ... };  // 80-90 行
export const DIMENSION_TIER: Record<string, number> = { ... };     // 93-103 行
```

---

## 二、map-atmosphere.ts

### annotateProperty → isAtmosphereProperty

```typescript
// Before (111-115)
function annotateProperty(propertyName: string, componentClass: string): { dimension: string } | null {
  const match = ATMOSPHERE_WHITELIST.find(
    (a) => a.property === propertyName && a.componentClass === componentClass
  );
  return match ? { dimension: match.dimension } : null;
}

// After
function isAtmosphereProperty(propertyName: string, componentClass: string): boolean {
  return ATMOSPHERE_WHITELIST.some(
    (a) => a.property === propertyName && a.componentClass === componentClass
  );
}
```

### 删除 special note 逻辑（223-227 行）

```typescript
// Before
components.push({
  actor: actorShort,
  actorRefPath,
  property: propName,
  refPath: `${resolvedRefPath}.${propName}`,
  currentValue,
  note:
    annotation.dimension === "light_direction" && propName === "RelativeRotation"
      ? "决定光源方向和它在画面中的位置，影响量化指标(亮度分布)"
      : undefined,
});

// After — 删除 note 字段赋值，ComponentEntry 的 note 改为可选
components.push({
  actor: actorShort,
  actorRefPath,
  property: propName,
  refPath: `${resolvedRefPath}.${propName}`,
  currentValue,
});
```

### 删除维度汇总逻辑（232-243 行）

```typescript
// Before
if (components.length > 0) {
  const dims = [
    ...new Set(
      components
        .map((c) => {
          const a = ATMOSPHERE_WHITELIST.find(
            (w) => w.property === c.property && w.componentClass === cfg.compClass,
          );
          return a?.dimension;
        })
        .filter(Boolean),
    ),
  ] as string[];

  tiers.push({
    tier: cfg.tier,
    label: cfg.label,
    rationale: rationales[cfg.label] || "",
    dimensions: dims,
    components,
  });
}

// After — 不再收集 dimensions，TierEntry 去掉 dimensions 字段
if (components.length > 0) {
  tiers.push({
    tier: cfg.tier,
    label: cfg.label,
    rationale: rationales[cfg.label] || "",
    components,
  });
}
```

### TierEntry 类型

```typescript
// Before
interface TierEntry {
  tier: number;
  label: string;
  rationale: string;
  dimensions: string[];
  components: ComponentEntry[];
}

// After
interface TierEntry {
  tier: number;
  label: string;
  rationale: string;
  components: ComponentEntry[];
}
```

### 删除 _componentKeyToClass（272-286 行）

```typescript
// 整块删除 — 从未被调用
function _componentKeyToClass(key: string, actorClass: string): string { ... }
```

---

## 三、caller 适配

### capture.ts — 类型导入

```typescript
// Before (第 10 行)
import { ATMOSPHERE_COMPONENT_GLOBS, ATMOSPHERE_WHITELIST, type PropertyAnnotation } from "../tools/atmosphere-whitelist.ts";

// After
import { ATMOSPHERE_COMPONENT_GLOBS, ATMOSPHERE_WHITELIST } from "../tools/atmosphere-whitelist.ts";
// PropertyAnnotation 类型不再需要导入 — capture.ts 只在 131 行用它标注 local 变量，
// 可改用 typeof ATMOSPHERE_WHITELIST[number] 或直接内联
```

---

## 涉及文件清单（汇总）

| 文件 | 操作 |
|------|------|
| `src/tools/atmosphere-whitelist.ts` | 删 dimension 字段、去重 whitelist 条目、删 DIMENSION_LABELS、DIMENSION_TIER |
| `src/tools/map-atmosphere.ts` | annotateProperty→isAtmosphereProperty、删 special note、删 dimensions 汇总、删 _componentKeyToClass、TierEntry 类型去 dims |
| `src/presets/capture.ts` | 适配 import（PropertyAnnotation 类型不再从 whitelist 导出） |
