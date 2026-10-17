# Agent Note: Linux as a local community desktop target

Status: implemented

English | [中文](2026-10-12-linux-community-desktop-target.zh.md)

## Problem

The Desktop release path knew two platforms, macOS and Windows, and both assume a signing identity, a published update feed, and a policy service that issues mandatory-update rules. `package-target.ts` rejected every other host, `desktop-build-paths.mjs` refused any other target name, and `resolveDesktopPackageTarget` threw before a Linux build could start. A Kylin V10 SP1 host — aarch64 and x86_64 — could therefore build the product but not package it.

A Kylin deployment also cannot reuse the release assumptions. There is no Apple Developer ID or Windows certificate for a community build, no COS bucket holding a feed for it, and no policy service to answer for it. Treating Linux as another release target would have required standing up three services that the deployment does not have, and would have implied an update promise the project cannot keep.

## Decision

`linux-arm64` and `linux-x64` are Desktop **packaging** targets, not release targets. `DesktopPackageTarget` names that split: it widens the update-only `DesktopAutoUpdateTarget` with the two Linux names, and every consumer that publishes an update feed keeps indexing `DesktopAutoUpdateTarget`, so a Linux name is absent from those tables rather than present with a flag.

A Linux build produces a `deb` and an unpacked directory, and nothing else:

- **No signing.** `package-target.ts` runs the Linux packaging stage through the same `signedStage` helper as Windows, which returns the operation unwrapped when no signing identity applies. `--unsigned` stays Windows-only.
- **No update feed and no mandatory policy.** `createElectronBuilderConfig` skips `resolveDesktopAutoUpdateConfig` and leaves `publish` at `null`, and it omits `dshMandatoryUpdatePolicy` from `extraMetadata` instead of writing an undefined value. The runtime already treats a missing policy as "no forced update", so the packaged manifest carries no policy field at all.
- **A completion record is still written.** `desktopBuildRecordFilename` accepts the Linux names through a record-only set, so the local numbering pass and any future tooling can read what was built and from which commit. Its `environment` reads `local`; see the consequences.
- **`depends` lists only the libraries Electron itself needs.** The runtime is self-contained, so no package pulls in a JRE, a browser, or an office suite.

Identity and shell integration are decided in `electron-builder-config.mjs`:

- `executableName` is `deepseek-harness`. electron-builder's default derives from the sanitized package name, which for `@deepseek-ai/dsh-desktop` is `@deepseek-aidsh-desktop` — unusable as a command and inconsistent with the packaged smoke's own path.
- `package.json` declares `desktopName: deepseek-harness.desktop`, and `linux.syncDesktopName: true` makes the `.desktop` filename, the `StartupWMClass`, and Electron's `app_id` the same string. Without `desktopName` the WM class falls back to the product name `DeepSeek Harness`, which the window manager cannot match against a `.desktop` filename, so running windows never associate with their launcher entry.
- `linux.icon` points at the `resources/icons` **directory**. electron-builder installs each `<N>x<N>.png` into `hicolor/<N>x<N>/apps/`, and desktop environments only find an icon whose size appears in the installed `index.theme` `Directories` list. A single large PNG installs into a size directory no theme lists, so the launcher silently falls back to a generic icon.
- `deb.afterInstall` and `deb.afterRemove` are the electron-builder 26.15.3 default templates with one addition each: link `/usr/bin/dsh` to the packaged `resources/runtime/cli/bin/dsh`, and remove it again. The deb payload itself places nothing on `PATH`, so without the link the CLI is unreachable from a terminal — and headless driving is a primary use of this product.

## Alternatives considered

**Ship an AppImage.** It needs no maintainer scripts and runs from any directory, but it puts the runtime inside a squashfs image, which fights both the `app.asar` layout and the bundled pnpm's need to write into the runtime tree. A `deb` also gives the deployment a package manager record, which is what a Kylin fleet operator expects.

**Point `linux.icon` at one large PNG.** electron-builder accepts it and the build succeeds, which is what makes this tempting. The result is an icon in `hicolor/1104x1104/apps/` that no `index.theme` lists.

**Reuse the release plumbing with a dummy feed.** `resolveDesktopAutoUpdateConfig` would then have to accept a target with no bucket, no key prefix, and no origin. Two targets would share a code path that can only be exercised by inventing values for one of them, and a packaged app would gain an updater that fails at runtime instead of having none.

**Set `publish: null` but keep the policy field.** `extraMetadata` forwards whatever it is given; writing `dshMandatoryUpdatePolicy: undefined` would put the key in the manifest with no value for any consumer that enumerates keys. Omitting the key states the same thing unambiguously.

**Link `/usr/bin/dsh` from the package payload instead of a maintainer script.** electron-builder has no payload-mapping facility for paths outside `/opt`, and a hand-written `postinst` would have to reproduce the default template's `update-alternatives`, `chrome-sandbox`, MIME, desktop-database, and AppArmor handling — which is exactly the code the template already owns.

## Consequences

A Linux build has no auto-update and no forced-update capability. Releasing a fix means shipping a new `deb`; an operator upgrades with the package manager. `upload-target.ts` and `desktop-upload-plan.ts` have no Linux entry, so a Linux artifact cannot be pushed to a bucket even by mistake.

The completion record carries `environment: local`, a value outside `DesktopAutoUpdateEnvironment` (`test | production`). No consumer reads it today — upload indexes only release targets — but the record schema now has a third state that the type does not name. Any future consumer that switches on the environment must handle it or reject it explicitly.

The `depends` names are the Debian-era spellings (`libasound2`, not the Ubuntu 24.04 `libasound2t64`). All fourteen resolve on Kylin V10 SP1, which is the target. A newer Debian-family host would fail to install because `apt` cannot satisfy `libasound2`.

Window icons are a separate concern from the launcher icon: `main.ts` sets the window `icon` explicitly so the title bar, Alt-Tab, and panel do not fall back to a generic glyph when the WM class association has not been established yet. Tray bitmaps are a third: `tray.png` plus `tray@2x.png` are picked up by `nativeImage` with its own scale selection, which the Windows multi-size ICO path does not provide.

Adding a Linux architecture means touching the target vocabulary in six places — the union in `package-target.ts`, the set and four JSDoc unions in `desktop-build-paths.mjs`, the record set in `desktop-auto-update-environment.mjs`, the two types in its `.d.mts`, four script entries in each `package.json`, and both Desktop READMEs. This duplication predates Linux (the `mac-arm64` name already appeared six times in `desktop-build-paths.mjs`), and widening the vocabulary made it more expensive to keep aligned.
