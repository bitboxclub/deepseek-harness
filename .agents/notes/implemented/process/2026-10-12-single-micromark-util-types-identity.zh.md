# Agent Note：Markdown 闭包中统一的 `micromark-util-types` 类型身份

Status: implemented

[English](2026-10-12-single-micromark-util-types-identity.md) | 中文

## Problem

`pnpm-lock.yaml` 把 `micromark-util-types` 解析成两份：`mdast-util-from-markdown@2.0.3` 与 `micromark-extension-gfm@3.0.0` 用 `2.0.2`，而 `micromark@4.0.2` 核心、全部 GFM 子扩展、math 扩展与各 factory 包用 `2.0.3`。所有消费方都声明 `^2.0.0`，因此分裂源自解析，而非需求冲突。

TypeScript 把两份副本视为无关类型。`packages/client/ui-primitives/src/markdown/parse.ts` 用 CJK 扩展（经直接依赖拿到 `2.0.3`）构造扩展数组并传给 `fromMarkdown`（按 `2.0.2` 定型），产生 `TS2769`，比较链末端的报错是 `'listItem' is not assignable to type 'keyof TokenTypeMap'`。失败发生在 `build:lib`，于是仓库内什么都构建不出来。

分裂随着一次 lockfile 刷新到来，同一次刷新还把 Electron 从 44.0.0 提到 44.7.0；该分支之后没有跑过完整 `build:lib`，所以本序列中的首次全量构建也是首次看见它。

## Decision

`pnpm-workspace.yaml` 把 `micromark-util-types` 覆盖为 `2.0.3`——运行时核心与全部扩展本就运行在该版本——lockfile 随之解析出单一副本。

覆盖写在 `pnpm-workspace.yaml` 而非根 `package.json`：pnpm 11 不再读取后者的 `pnpm` 字段并会报告已忽略，写在那里的覆盖不生效，且每次调用都产生告警。

## Alternatives considered

**把 `ui-primitives` 自身的依赖钉在 `2.0.2`。** 扩展数组里 CJK 扩展与 `math()` 混用，后者来自 `2.0.3` 的包；钉住直接依赖只会把不匹配留在同一个数组里。

**升级仍解析到 `2.0.2` 的那些包。** 它们是闭包的两个入口包，移动它们会改变 Web 客户端的 Markdown 管线、文档门禁所用的解析器、以及每个渲染 Markdown 的包。类型身份分裂是解析产物，不是那些版本有错的信号。

**保留分裂并在调用处加断言。** 断言会压制唯一报告该不匹配的机制。两份副本结构上确有差异——`2.0.3` 带有 `2.0.2` 没有的 token 类型——因此被传入的数组确实不是 `fromMarkdown` 编译时所依据的类型。

## Consequences

仓库中只保留一份 `micromark-util-types`，闭包解析无告警。覆盖是 `pnpm-workspace.yaml` 中的常驻指令；即使入口包日后追上，它仍可留着——因为那些包接受 `^2.0.0`，故无害——去掉它只需一次 lockfile 刷新。

本次改动的 lockfile diff 大于覆盖本身：pnpm 重新解析了图中到达 `micromark-util-types` 的那部分，而 Electron 从 44.0.0 到 44.7.0 的移动在同一文件中贡献了各自的条目。

早前失败构建留下的陈旧 `tsconfig.tsbuildinfo` 会在依赖树已一致后仍重放旧诊断，因为 `tsc -b` 判定源文件未变，不会重读已被替换的声明文件。任何涉及该部分依赖图的改动都必须先删除增量构建状态，结果才可信。
