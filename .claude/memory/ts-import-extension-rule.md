---
name: ts-import-extension-rule
description: Pi 项目中 .ts 文件的相对导入必须用 .ts 扩展名，不能用 .js 也不能省略
metadata:
  type: constraint
---

Pi monorepo 的 tsconfig 设了 `moduleResolution: "Node16"` + `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`，导致一条硬规则：

**相对导入必须写 `.ts` 扩展名。**

```typescript
// ❌ 省略扩展名 — tsgo 报错 TS2835
import { Foo } from "./foo";

// ❌ .js 扩展名 — check-ts-relative-imports 报错
import { Foo } from "./foo.js";

// ✅ 唯一正确写法
import { Foo } from "./foo.ts";
```

`rewriteRelativeImportExtensions: true` 确保输出时 `.ts` 自动替换为 `.js`，不影响运行时。

**Why:** 2026-08-09 提交时两次触发 pre-commit hook 失败。先按 tsgo 要求写好 `.js`，被 `check:ts-imports` 拦下；去掉扩展名，又被 tsgo 拦下。最终确认 `.ts` 是两者共同接受的唯一写法。

**How to apply:** 每次在 ue-harness 中写相对 import 时，手动检查扩展名是 `.ts`。不要依赖编辑器自动补全（通常会补 `.js`）。新增子模块时全局用 sed 扫一遍确保一致。
