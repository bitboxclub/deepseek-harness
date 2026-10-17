# Agent Note：在物化的归档副本上验证打包运行时

Status: implemented

[English](2026-10-12-packaged-runtime-smoke-materialization.md) | 中文

## Problem

`smoke-prepared-runtime.ts` 针对准备好的 `dsh` 根运行载荷 fixture 与 Host。打包完成后该根位于 `app.asar` 内，而冒烟的 fixture 以打包后 Electron 二进制的 Node 模式子进程运行。那里的每次文件系统调用都直达操作系统，因此 `readFileSync('…/app.asar/dsh/desktop-runtime.json')` 以 `ENOTDIR` 失败：`app.asar` 是单个文件，操作系统无法穿越。

Electron 的 ASAR 包装器本应让该路径可用，但在这个子进程中它没有接管。包装器出自 Electron `lib/node/asar-fs-wrapper.ts` 的一次性能改写，它通过 `stat` 判断路径是否位于归档内，而 Node 模式子进程在任何包装器判定之前就经操作系统解析了该路径。归档本身完好——`@electron/asar` 能列出其全部条目，`verifyRuntimeArchive` 逐字节匹配封闭清单——因此失败在于如何读取副本，而非写入了什么。

物化归档又暴露出第二种失败。`app-builder-lib` 对被标记为 `unpacked` 的条目**不写归档头的 `executable` 标志**，而 `extractAll` 正是依据该标志决定 `chmod 755`，于是全部 1037 个解包文件以默认权限落地。fixture 随后 spawn 解包出来的 `rg`，得到 `EACCES`。归档旁真实的 `app.asar.unpacked` 树携带正确权限，因为那正是打包应用自身执行的文件。

## Decision

`materializeArchive` 把归档解到其旁的临时目录，冒烟针对该副本运行而非归档本身。随后 `restoreUnpackedModes` 把 `app.asar.unpacked` 的权限逐文件映射到解包副本上，使副本携带与打包应用运行时相同的权限。打包进归档的条目沿用 `extractAll` 已从头信息应用的标志；两个来源合起来构成每个文件权限的完整事实。

仅当准备好的根位于归档内时才执行物化（`asarArchiveOf`），因此普通暂存目录——`--dir` 与 `prepare-only` 路径——原地验证，不产生副本也不付出额外开销。

次序是刻意的：`verifyRuntimeArchive` 在副本被使用之前运行，因此冒烟所验证的字节已与封闭清单匹配过。物化并未削弱完整性主张，它改变的是同一批已验证字节经由哪个文件系统被读取。

## Alternatives considered

**对打包产物跳过冒烟。** 打包冒烟是唯一针对真正随包交付内容运行 fixture 的检查——`--dir` 路径验证的是布局与安装态不同的暂存树。去掉它就会移除这一系列中所发现的每个缺陷的捕获者。

**在 fixture 中经 `@electron/asar` 读取归档内容。** fixture 将不得不放弃普通的 `readFileSync` 与 `spawn`，而那正是打包应用所依赖的行为。经归档 API 读取的 fixture 无法观测到权限位或路径解析缺陷。

**设置 `ELECTRON_NO_ASAR` 并读取解包树。** 那会为整个进程禁用 ASAR 层，包括冒烟同时启动的 Host 子进程，于是这次运行不再与打包应用相似。

**只对 `rg` 二进制 chmod。** `app.asar.unpacked` 携带十二个可执行文件——ripgrep 二进制、Office wasm 资产、两个 sherpa `.so` 及其 `.node`、一个 koffi `.node`、以及若干 `.cjs` 助手。只修失败的那一个，会让 fixture 下一次新增的 spawn 以同样方式失败，而这正是该缺陷最初浮现的方式。

**依赖 `extractAll` 并事后修补其输出。** `extractAll` 读取头标志，而缺失的正是该头标志；对头信息做事后处理无法恢复头从未记录的权限。

## Consequences

打包冒烟多付一次应用归档解包（14.8 MB、12 302 个条目约 0.8 s）与一次 1037 文件的目录遍历，且仅在打包路径上。

两个 Electron 行为从此记录在此，而非被重新发现：Node 模式子进程经操作系统而非 ASAR 包装器解析路径；归档头不为解包条目携带执行权限。二者都是所安装的 Electron 44 与 `app-builder-lib` 26.15.3 的性质；将来某个版本若改变其中之一，物化将变得多余但无害。

物化副本在冒烟的 `finally` 块中删除，因此失败的运行不会在产物旁留下解包运行时文件树。

副本获得的权限来自 `app.asar.unpacked`，因此若 `app-builder-lib` 往那棵树写入了错误权限，冒烟不会发现。那棵树正是安装后应用所执行的内容，所以这类缺陷属于 electron-builder 的打包缺陷而非本仓库的，且打包冒烟的载荷检查会直接在其上失败。
