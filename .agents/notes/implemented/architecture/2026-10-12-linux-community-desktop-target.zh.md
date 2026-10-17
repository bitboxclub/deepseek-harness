# Agent Note：Linux 作为本地社区版桌面目标

Status: implemented

[English](2026-10-12-linux-community-desktop-target.md) | 中文

## Problem

桌面发布链路只认识 macOS 与 Windows 两个平台，而两者都以签名身份、已发布的更新源、以及签发强制更新规则的政策服务为前提。`package-target.ts` 拒绝其它构建主机，`desktop-build-paths.mjs` 拒绝其它目标名，`resolveDesktopPackageTarget` 在任何 Linux 构建开始前就抛错。因此银河麒麟 V10 SP1 主机（aarch64 与 x86_64）能构建本产品，却无法打包。

麒麟部署也无法沿用发布侧的假设：社区构建没有 Apple Developer ID 或 Windows 证书，没有存放它的更新源的 COS 桶，也没有能替它应答的政策服务。把 Linux 当作又一个发布目标，意味着要凭空立起三项该部署并不具备的服务，并暗示一个项目无法兑现的更新承诺。

## Decision

`linux-arm64` 与 `linux-x64` 是桌面**打包**目标，不是发布目标。`DesktopPackageTarget` 表达了这一区分：它在仅用于发布的 `DesktopAutoUpdateTarget` 之上扩展出两个 Linux 名称，而每个发布更新源的消费方仍以 `DesktopAutoUpdateTarget` 索引，于是 Linux 名称在这些表中是缺席的，而不是带着标志出现。

Linux 构建产出一个 `deb` 与一个解包目录，此外没有别的：

- **无签名。** `package-target.ts` 让 Linux 打包阶段走与 Windows 相同的 `signedStage` 助手，在没有签名身份时该助手直接返回未包装的操作。`--unsigned` 仍仅限 Windows。
- **无更新源、无强制策略。** `createElectronBuilderConfig` 跳过 `resolveDesktopAutoUpdateConfig`，`publish` 保持 `null`，并且从 `extraMetadata` 中省略 `dshMandatoryUpdatePolicy`，而不是写入一个 undefined 值。运行时本就把缺失的策略视为"不强制更新"，因此打包清单里完全没有策略字段。
- **仍写入完成记录。** `desktopBuildRecordFilename` 通过一个仅用于记录的集合接受 Linux 名称，于是本地编号流程与后续工具都能读到构建了什么、来自哪个提交。其 `environment` 为 `local`，见"Consequences"。
- **`depends` 只列 Electron 自身所需的库。** 运行时自包含，因此没有任何包会拖入 JRE、浏览器或办公套件。

身份与桌面集成在 `electron-builder-config.mjs` 中决定：

- `executableName` 为 `deepseek-harness`。electron-builder 的默认值取自经 sanitize 的包名，对 `@deepseek-ai/dsh-desktop` 而言是 `@deepseek-aidsh-desktop`——既不能作命令，也与打包冒烟自检的路径不一致。
- `package.json` 声明 `desktopName: deepseek-harness.desktop`，配合 `linux.syncDesktopName: true` 使 `.desktop` 文件名、`StartupWMClass` 与 Electron 的 `app_id` 成为同一个字符串。缺少 `desktopName` 时 WM class 回退为产品名 `DeepSeek Harness`，窗口管理器无法把它与 `.desktop` 文件名匹配，运行中的窗口因而永远关联不到自己的启动器条目。
- `linux.icon` 指向 `resources/icons` **目录**。electron-builder 把每个 `<N>x<N>.png` 安装到 `hicolor/<N>x<N>/apps/`，而桌面环境只查找尺寸出现在已安装 `index.theme` 的 `Directories` 清单中的图标。单张大 PNG 会装进没有任何主题列举的尺寸目录，启动器于是静默退回通用图标。
- `deb.afterInstall` 与 `deb.afterRemove` 是 electron-builder 26.15.3 的默认模板，各加一处：把 `/usr/bin/dsh` 链接到包内 `resources/runtime/cli/bin/dsh`，以及再次移除它。deb 载荷本身不往 `PATH` 放任何东西，没有这个链接终端就敲不到 CLI——而无头驱动恰恰是本产品的主要用法之一。

## Alternatives considered

**交付 AppImage。** 它不需要维护者脚本，且可从任意目录运行，但它把运行时放进 squashfs 镜像，与 `app.asar` 布局、以及随包 pnpm 需要写入运行时树这两点相冲突。`deb` 还为部署方留下包管理器记录，这是麒麟机群运维者所期望的。

**`linux.icon` 指向一张大 PNG。** electron-builder 接受它，构建照常成功——这正是它诱人的原因。结果是图标落在 `hicolor/1104x1104/apps/`，没有任何 `index.theme` 列举该尺寸。

**用假更新源复用发布链路。** 这要求 `resolveDesktopAutoUpdateConfig` 接受一个没有桶、没有键前缀、没有 origin 的目标。两个目标将共用一条只能靠为其一编造取值才走得到的代码路径，且打包后的应用会得到一个运行期必然失败的更新器，而不是干脆没有。

**设 `publish: null` 但保留策略字段。** `extraMetadata` 原样转发所给内容；写入 `dshMandatoryUpdatePolicy: undefined` 会让该键出现在清单里却没有值，任何枚举键的消费方都会撞上。省略该键是无歧义的等价表述。

**由包载荷而非维护者脚本创建 `/usr/bin/dsh`。** electron-builder 没有为 `/opt` 之外的路径提供载荷映射机制，而手写 `postinst` 必须复现默认模板的 `update-alternatives`、`chrome-sandbox`、MIME、desktop-database 与 AppArmor 处理——那正是模板已经拥有的代码。

## Consequences

Linux 构建不具备自动更新与强制更新能力。发布修复意味着交付新的 `deb`，运维者用包管理器升级。`upload-target.ts` 与 `desktop-upload-plan.ts` 没有 Linux 条目，因此 Linux 产物即便误操作也无法推送到桶。

完成记录携带 `environment: local`，该值位于 `DesktopAutoUpdateEnvironment`（`test | production`）之外。当前没有消费方读取它——上传只索引发布目标——但记录 schema 由此有了类型未命名的第三种状态。任何将来按 environment 分支的消费方必须处理它或显式拒绝它。

`depends` 中的名称采用 Debian 时代的拼写（`libasound2`，而非 Ubuntu 24.04 的 `libasound2t64`）。十四个依赖在麒麟 V10 SP1 上全部可解析，而麒麟就是目标平台。更新的 Debian 系主机将因 `apt` 无法满足 `libasound2` 而安装失败。

窗口图标与启动器图标是两件事：`main.ts` 显式设置窗口 `icon`，使标题栏、Alt-Tab 与面板在 WM class 关联尚未建立时不退回通用图形。托盘位图是第三件事：`tray.png` 与 `tray@2x.png` 由 `nativeImage` 连同其自身的缩放选择一同取用，这是 Windows 的多尺寸 ICO 路径所不具备的。

新增一个 Linux 架构需要改动六处目标词表——`package-target.ts` 的联合类型、`desktop-build-paths.mjs` 的集合与四处 JSDoc 联合、`desktop-auto-update-environment.mjs` 的记录集合、其 `.d.mts` 中的两个类型、两个 `package.json` 各四条脚本、以及两份桌面 README。这一重复早于 Linux 存在（`mac-arm64` 在 `desktop-build-paths.mjs` 中已出现六次），而词表的扩展使保持一致的代价更高。
