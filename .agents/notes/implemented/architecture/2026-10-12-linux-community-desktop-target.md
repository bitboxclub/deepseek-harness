# Agent Note: Linux as a local community desktop target

Status: implemented

English | [中文](2026-10-12-linux-community-desktop-target.zh.md)

## Problem

The Desktop release path knew two platforms, macOS and Windows, and both assume a signing identity, a published update feed, and a policy service that issues mandatory-update rules. `package-target.ts` rejected every other host, `desktop-build-paths.mjs` refused any other target name, and `resolveDesktopPackageTarget` threw before a Linux build could start. A Kylin V10 SP1 host — aarch64 and x86_64 — could therefore build the product but not package it.

A Kylin deployment also cannot reuse the release assumptions. There is no Apple Developer ID or Windows certificate for a community build, no COS bucket holding a feed for it, and no policy service to answer for it. Treating Linux as another release target would have required standing up three services that the deployment does not have, and would have implied an update promise the project cannot keep.

## Decision

`linux-arm64` and `linux-x64` are Desktop **packaging** targets, not release targets. `DesktopPackageTarget` names that split: it widens the update-only `DesktopAutoUpdateTarget` with the two Linux names, and every consumer that publishes an update feed keeps indexing `DesktopAutoUpdateTarget`, so a Linux name is absent from those tables rather than present with a flag.

The [Electron packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) recorded Linux as having no release target; this note replaces that row with a packaging-only target.

A Linux build produces a `deb` and an unpacked directory; the only other file it writes is the completion record:

- **No signing.** `package-target.ts` runs the Linux packaging stage through the same `signedStage` helper as Windows, which returns the operation unwrapped when no signing identity applies. `--unsigned` stays Windows-only.
- **No update feed and no mandatory policy.** `createElectronBuilderConfig` skips `resolveDesktopAutoUpdateConfig` and leaves `publish` at `null`, and it omits `dshMandatoryUpdatePolicy` from `extraMetadata` instead of writing an undefined value. The runtime already treats a missing policy as "no forced update", so the packaged manifest carries no policy field at all.
- **A completion record is still written.** `desktopBuildRecordFilename` accepts the Linux names through a record-only set, so the target has a completion record like every other one. It omits the update fields instead of inventing an environment value; see the consequences.
- **`depends` lists only the libraries Electron itself needs.** The runtime is self-contained, so no Debian dependency pulls in a JRE, a browser, or a native office suite; the Office engine ships inside the runtime as WASM.

Identity and shell integration are decided in `electron-builder-config.mjs`:

- `executableName` is `deepseek-harness`. electron-builder's default derives from the sanitized package name, which for `@deepseek-ai/dsh-desktop` is `@deepseek-aidsh-desktop` — unusable as a command and inconsistent with the packaged smoke's own path.
- `package.json` declares `desktopName: deepseek-harness.desktop`, and `linux.syncDesktopName: true` makes the `.desktop` file stem, the `StartupWMClass`, and Electron's `app_id` the same string. Without `desktopName` the WM class falls back to the product name `DeepSeek Harness`, which the window manager cannot match against a `.desktop` filename, so running windows never associate with their launcher entry.
- `linux.icon` points at the `resources/icons` **directory**. electron-builder installs each `<N>x<N>.png` into `hicolor/<N>x<N>/apps/`, and desktop environments only find an icon whose size appears in the installed `index.theme` `Directories` list. A single large PNG installs into a size directory no theme lists, so the launcher silently falls back to a generic icon.
- `deb.afterInstall` and `deb.afterRemove` are the electron-builder 26.15.3 default templates with one addition each: register `/usr/bin/dsh` in `update-alternatives` against the packaged `resources/runtime/cli/bin/dsh`, and remove that entry again. `update-alternatives` is the mechanism the template already uses for the application binary, so a `/usr/bin/dsh` owned by another package is neither replaced nor deleted. The deb payload itself places nothing on `PATH`, so without the link the CLI is unreachable from a terminal — and headless driving is a primary use of this product.

## Alternatives considered

**Ship an AppImage.** It needs no maintainer scripts and runs from any directory, but it puts the runtime inside a squashfs image, which fights both the `app.asar` layout and the bundled pnpm's need to write into the runtime tree. A `deb` also gives the deployment a package manager record, which is what a Kylin fleet operator expects.

**Point `linux.icon` at one large PNG.** electron-builder accepts it and the build succeeds, which is what makes this tempting. The result is an icon in `hicolor/1104x1104/apps/` that no `index.theme` lists.

**Reuse the release plumbing with a dummy feed.** `resolveDesktopAutoUpdateConfig` would then have to accept a target with no bucket, no key prefix, and no origin. Two targets would share a code path that can only be exercised by inventing values for one of them, and a packaged app would gain an updater that fails at runtime instead of having none.

**Set `publish: null` but keep the policy field.** `extraMetadata` forwards whatever it is given; writing `dshMandatoryUpdatePolicy: undefined` would put the key in the manifest with no value for any consumer that enumerates keys. Omitting the key states the same thing unambiguously.

**Link `/usr/bin/dsh` from the package payload instead of a maintainer script.** electron-builder has no payload-mapping facility for paths outside `/opt`, and a hand-written `postinst` would have to reproduce the default template's `update-alternatives`, `chrome-sandbox`, MIME, desktop-database, and AppArmor handling — which is exactly the code the template already owns.

## Consequences

A Linux build has no auto-update and no forced-update capability. Releasing a fix means shipping a new `deb`; an operator upgrades with the package manager. `upload-target.ts` and `desktop-upload-plan.ts` have no Linux entry, so a Linux artifact cannot be pushed to a bucket even by mistake.

The completion record carries no `environment` or `publicUrl`. No consumer reads those fields for a feed-less target — upload indexes release targets only — and omitting them keeps every recorded update field at a value `DesktopAutoUpdateEnvironment` names.

The `depends` names are the Debian-era spellings (`libasound2`, not the Ubuntu 24.04 `libasound2t64`). All fifteen resolve on Kylin V10 SP1, which is the target. `libuuid1` comes from electron-builder's own default list, which is kept in full because supplying `depends` replaces it. A newer Debian-family host would fail to install because `apt` cannot satisfy `libasound2`.

Window icons are a separate concern from the launcher icon: `main.ts` sets the window `icon` explicitly so the title bar, Alt-Tab, and panel do not fall back to a generic glyph when the WM class association has not been established yet. Tray bitmaps are a third: `tray.png` plus `tray@2x.png` are picked up by `nativeImage` with its own scale selection, which the Windows multi-size ICO path does not provide.

A target name is written as a literal union, set, or regular expression in each packaging script that handles it — `package-target.ts`, `desktop-build-paths.mjs` and its `.d.mts`, `desktop-auto-update-environment.mjs` and its `.d.mts`, `desktop-build-version-discovery.ts`, the Electron binary names in `prepare-runtime.ts` and `prepare-dsh.ts`, the packaged paths in `smoke-packaged-runtime.ts`, and both `package.json` script lists. Nothing derives that list from a single source, so a new architecture has to be added to each of them.
