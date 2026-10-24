# Agent Note: 把 pnpm 的虚拟仓库固定在项目内

Status: implemented

[English](2026-10-12-pinned-pnpm-virtual-store-layout.md) | 中文

## Problem

pnpm 11 的 `enableGlobalVirtualStore` 没有单一默认值。pnpm 自身的配置解析在 `CI` 为真时把它设为 `false`，否则留空，因此同一个仓库会依据安装的调用方式产生两种取值。

打包宿主上的 workspace 安装与随后的打包步骤取的是两种取值。根 `postinstall` 运行 `scripts/install-lefthook.mjs`，该脚本要求 git 2.26；产出本次改动的麒麟宿主是 2.25.1，因此操作者以 `CI=true` 执行 `pnpm install` 让它提前返回。其后的打包步骤则不在 `CI` 下调用 pnpm。

两个取值以 pnpm 无法容忍的方式冲突：记录在 `node_modules/.pnpm-workspace-state-v1.json` 里的 workspace 状态是 `false`，稍后解析出的是空值，pnpm 据此判定 `node_modules` 过期，并尝试删除重建。没有 TTY 时，终局是 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。

## Decision

`pnpm-workspace.yaml` 设 `enableGlobalVirtualStore: false`，为每次调用固定布局，与 `CI` 无关。

取值必须是 `false` 而非 `true`。这是项目安装，`.pnpm` 属于项目内部。`true` 会把虚拟仓库移入全局 store 的 `links/`，electron-builder 的 node 模块收集器便再也找不到 `electron-updater` 的传递依赖：打包日志报 `dependency not found on disk`，产出的 `app.asar` 缺少 `fs-extra` 等包，应用启动即 `Cannot find module 'fs-extra'`。

## Alternatives considered

**让每次 pnpm 调用都带 `CI=true`。** 它通过让每次调用走同一分支来对齐取值，但会改变那些与 CI 无关的打包步骤的 pnpm 行为：重试与进度行为，以及任何将来由同一机制门控的设置。它也把这一错误配置留给任何手动执行安装的人。

**提高 git 要求并去掉 `CI=true`。** 宿主的 git 就是如此，安装必须在它上面工作。

**设 `enableGlobalVirtualStore: true`。** 它同样能让布局一致，并按上文所述破坏打包——这个取值不是两种等价布局之间的自由选择。

## Consequences

`node_modules/.pnpm` 在每次安装后都留在项目内，这正是 electron-builder 收集器所期望的布局，也是 pnpm 11 引入该开关之前仓库既有的布局。

该设置对开发安装与打包安装同样生效。使用较旧 pnpm 的贡献者会把该键视为未知而非错误，因为运行中的 pnpm 会忽略它不认识的 workspace 设置，而不拒绝。

底层冲突仍在：在 git 低于 2.26 的宿主上，`CI=true` 仍被用来绕过该 `postinstall`。若放宽 `scripts/install-lefthook.mjs` 来修好这一点，混合调用的理由便不存在，该设置也将变得多余而非错误。
