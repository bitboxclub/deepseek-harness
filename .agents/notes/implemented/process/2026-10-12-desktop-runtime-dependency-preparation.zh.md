# Agent Note: 慢速镜像下的桌面运行时依赖准备

Status: implemented

[English](2026-10-12-desktop-runtime-dependency-preparation.md) | 中文

## Problem

`prepare-dsh.ts` 负责安装随包运行时的依赖闭包——约 533 个包，其中含 48 MB 的 `libreoffice-kit-wasm` tarball——而它把依赖装进 `BUILD_ROOT` 下用 `mkdtemp` 创建的仓库目录。于是每次打包都要把整个闭包重下一遍。在慢速注册表链路上，这一遍就是失败的那一遍：pnpm 默认 `fetch-timeout` 为 60 s，在 tarball 下载途中就到期，三次重试同样到期，构建随即失败。

当受影响的恰好是 Office 引擎时，失败还是静默的。`@deepseek-ai/libreoffice-kit` 把引擎声明为**可选**依赖，因此 pnpm 把取不到的 tarball 记为 skipped 并仍然退出 0。`runtime:install` 在引擎缺席的情况下报告成功，构建则在很久之后、在打包冒烟处失败，错误信息点出的是引擎名而非下载。

## Decision

四处改动，各自回应上述一种失败。

**仓库改为持久化，不再落在每次运行新建的临时树内。** `STORE_ROOT` 取 `BUILD_PATHS.pnpmStore`，即缓存根下的共享 `pnpm-store` 目录（`DSH_DESKTOP_PACKAGE_CACHE_DIR` 可改缓存根）。一个仓库服务所有目标，因为 pnpm 以内容寻址，平台专属的二进制包可以共存。温热的仓库把安装变成一遍链接。

**取用容差写进生成的 `npmrc`。** `runPnpm` 在启动 pnpm 前把 `fetch-timeout`、`fetch-retries`、`fetch-retry-mintimeout`、`fetch-retry-maxtimeout` 写入构建状态的 `npmrc`（30 分钟、6 次重试、20 s 至 300 s 退避）。它们不能以 `--config.*` 标志传递：CLI 的 `--config.X=value` 到 pnpm 手里是字符串，而 `fetch-timeout` 会被直接交给 `AbortSignal.timeout(number)`，对字符串抛 `TypeError: The "delay" argument must be of type number`——且是在重试循环内部，因此比它本想修复的超时更糟。`npmrc` 路径走 pnpm 自己的配置加载器，按 schema 转换类型。

**安装按有序注册表列表回退。** `runtimeRegistries()` 把已配置的注册表放在首位，随后两个镜像，去重后返回，并由 `DSH_DESKTOP_RUNTIME_REGISTRY` 替换回退列表。替换注册表不会改变装了什么：lockfile 以 integrity 锁定每个包，pnpm 逐个校验 tarball，而这些镜像只是提供相同字节的普通 npm 注册表。

**引擎缺席在暂存树仍存在时被发现并修复。** `officeEngineReady(engine)` 在安装后检查引擎包的 `prebuilds.json`。缺席时，`runtime:repair-office-engine` 依次对每个注册表重跑同一条 frozen 安装——代价很低，因为已在仓库中的包全部复用——若全部尝试后仍然缺席，构建立刻以引擎名失败，而不是拖到打包冒烟。

## Alternatives considered

**保留临时仓库，只调高超时。** 它只修好引发本次改动的那一个 tarball，别的什么都没修：每次运行仍要重下 533 个包，失败点只会转移到当天最慢的那个包上。

**以 `--config.fetch-timeout=…` 标志传递容差。** 实测会失败：值以字符串到达，`AbortSignal.timeout` 对它抛错，而且在 pnpm 的重试循环内反复抛。

**只把注册表指向一个更快的镜像。** 单点替换是全局部署选择，对下一台主机可能就是错的。已配置注册表加回退列表把部署的选择放在首位，并让回退成为构建期局部细节。

**把引擎缺席当作 `runtime:install` 的硬失败。** 那样报告准确，却无法区分"镜像送不到"与"包集里本就没有"，并且丢弃仓库中已完成的工作。修复流程复用的正是那部分工作。

**在打包冒烟处失败，即缺席首次可见之处。** 那正是被替换的行为：信息点出引擎而非下载，且要等到打包完成、运行时树物化之后才出现。

## Consequences

温热的仓库让重复打包的依赖步骤从分钟级降到秒级；首次运行仍要付出下载成本。仓库位于 `apps/desktop/.desktop-build/pnpm-store` 下，因此被 Git 忽略，也从不随包发布。

容差现在属于生成的 `npmrc`，这意味着打包运行的网络行为集中配置在一处，并且能在构建状态中看到，而不是由默认值隐含。

回退列表是构建期便利，不是分发决策：全部注册表皆失败时，错误是一个 `AggregateError`，其 `errors` 为每个注册表各保存一条失败记录。不得访问默认镜像的部署应把 `DSH_DESKTOP_RUNTIME_REGISTRY` 设为自己的列表。

若引擎确实不在包集中（而非送不到），它现在与下载失败报同样的信息，且要等每个注册表都试过。这一区别无法从存在性检查中观测到，而尝试的代价由仓库复用所限。
