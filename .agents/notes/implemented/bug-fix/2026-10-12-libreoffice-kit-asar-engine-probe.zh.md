# Agent Note: 放宽 ASAR 下的 LibreOfficeKit 引擎探测

Status: implemented

[English](2026-10-12-libreoffice-kit-asar-engine-probe.md) | 中文

## Problem

`@deepseek-ai/libreoffice-kit` 用 `(require.resolve.paths(name) ?? []).some((directory) => lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0)` 判断引擎包是否已安装。对不存在的路径，Node 返回 `undefined`。Electron 的 ASAR 文件系统层不同：归档中没有该条目时，其包装器返回 `null`（Electron 44 的 `lib/node/asar-fs-wrapper.ts` 中 `if (!stat) { …; return null }`）。

在打包后的应用里，引擎的每个 `require.resolve.paths()` 候选路径都位于 `app.asar` 内，于是探测把每个引擎都报成"已安装但不完整"。`resolveEngine` 随即抛 `Installed LibreOfficeKit package is incomplete: …-linux-arm64-glibc`，并且永不回退到运行时实际随包携带的 WASM 引擎，因为 Linux 原生引擎并不属于这次安装。同一份代码在 `lib/index.js`（编程接口）与 `lib/cli.js`（`dsoffice`，被 Office 技能与冒烟的 CLI 转换使用）中运行。

该缺陷在打包前不可见：普通目录返回 `undefined`，探测行为正常。`runtime:smoke` 通过，只有打包冒烟失败。

## Decision

`prepare-dsh.ts` 把比较改写为 `!= null`，它同时排除 `undefined` 与 `null`，改写在物化运行时的 `lib/index.js` 与 `lib/cli.js` 两处。补丁幂等（已含 `!= null` 的文件不再改动），并作为 `runtime:patch-office-kit` 步骤在 `runtime:write-descriptor` **之前**运行，因此 `verifyRuntimeArchive` 校验的封闭清单覆盖的是打过补丁的字节，而非上游字节。

若文件不含预期的 `!== void 0` 文本，则抛错并点出文件名及其守护的回退，使 kit 升级无法悄然恢复错误的比较。检查针对确切源码文本，而非行为探针：这个字节模式正是该决策所依赖的东西。

## Alternatives considered

**用模块钩子在运行期改写，而不是在磁盘上。** Host 确已为 Office 引擎解析安装了一个 `ModuleHooks` 实例，但失败的探测运行在 kit 自身的 `require.resolve` 路径内，以及 `dsoffice` CLI 子进程中，后者不共享 Host 的加载器钩子。改写字节可同时覆盖两个进程。

**只后处理 `lib/index.js`。** 冒烟的转换与 Office 技能实际调用的是 CLI 那份，只打一个会让每次文档转换仍带着打包后的失败。

**升级 `@deepseek-ai/libreoffice-kit`。** 那是真正的修复，但本次部署拿不到：该版本由桌面运行时随包的包集锁定，升级它会在同一次改动中改变所有平台的 Office 引擎矩阵。补丁被写成在下次升级时响亮失败，以便重新评估修复，而不是被悄然携带下去。

**通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 打补丁。** 那是本仓库改变依赖内部实现的机制，且对开发安装与打包安装同样生效。但它到不了这棵树：运行时闭包由 `BUILD_ROOT` 下自动生成的独立项目以 `--frozen-lockfile` 与 `--trust-lockfile` 安装，打包副本再从该树物化。要用 `patchedDependencies`，必须另外把它穿进运行时项目及其 lockfile，其改动量超出该缺陷所能支撑的范围。

**通过在 kit 模块作用域内包装 `lstatSync` 来放宽探测。** 任何包装器都得落在同样需要打补丁的那些文件里，因此直接改写更小，也更直白地陈述了改动。

## Consequences

打包后的应用对每个原生探测无法确认的引擎都回退到 WASM 引擎，这正是运行时的意图：Linux 原生引擎未安装，WASM 引擎随包提供。

补丁是对第三方文件的字节级依赖。若某次版本升级重命名变量、重排比较或搬移函数，`runtime:patch-office-kit` 会失败并点出文件名——这是预期结果，失败的构建就是评估上游修复是否已落地的信号。

开发安装保留未打补丁的包。因此 `pnpm dev:desktop` 运行的 kit 行为与打包应用不同；差异局限于引擎存在性探测，这也正是该决策住在 Agent Note 而非注释里的原因。
