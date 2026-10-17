# Agent Note: Pinning pnpm's virtual store inside the project

Status: implemented

English | [中文](2026-10-12-pinned-pnpm-virtual-store-layout.zh.md)

## Problem

pnpm 11's `enableGlobalVirtualStore` has no single default. pnpm's own configuration resolution sets it to `false` when `CI` is truthy and leaves it unset otherwise, so the same repository produces two different values depending on how the install was invoked.

This repository's install is invoked both ways in one build. The root `postinstall` runs `scripts/install-lefthook.mjs`, which requires git 2.26 and its host has 2.25.1, so packaging runs `pnpm install` with `CI=true` to make that script exit early. The packaging steps afterwards call pnpm without `CI`.

The two values disagree in a way pnpm does not tolerate: the workspace state recorded in `node_modules/.pnpm-workspace-state-v1.json` says `false`, the later resolution produces an empty value, pnpm concludes `node_modules` is stale, and attempts to remove and rebuild it. Without a TTY that ends as `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.

## Decision

`pnpm-workspace.yaml` sets `enableGlobalVirtualStore: false`, fixing the layout for every invocation regardless of `CI`.

The value must be `false`, not `true`. This is a project install, and `.pnpm` belongs inside the project. `true` moves the virtual store into the global store's `links/`, and electron-builder's node-module collector no longer finds `electron-updater`'s transitive dependencies: the packaging log reports `dependency not found on disk`, the produced `app.asar` omits packages such as `fs-extra`, and the application exits at startup with `Cannot find module 'fs-extra'`.

## Alternatives considered

**Run every pnpm invocation with `CI=true`.** It aligns the values by making every call take the same branch, but it changes pnpm's behaviour for packaging steps that have nothing to do with CI: retry and progress behaviour, and any future setting the same mechanism gates. It also leaves the misconfiguration in place for anyone who runs an install by hand.

**Raise the git requirement and drop `CI=true`.** The host's git is what it is; the install must work there.

**Set `enableGlobalVirtualStore: true`.** It makes the layout consistent too, and it breaks packaging as described above — the value is not a free choice between two equivalent layouts.

## Consequences

`node_modules/.pnpm` stays inside the project on every install, which is the layout electron-builder's collector expects and the layout the repository had before pnpm 11 introduced the flag.

The setting applies to development installs as well as packaging ones. A contributor on an older pnpm sees the key as unknown rather than wrong, because workspace settings unknown to the running pnpm are ignored rather than rejected.

The underlying conflict remains: `CI=true` is still needed to bypass a `postinstall` that requires a newer git than the packaging host has. Fixing that by relaxing `scripts/install-lefthook.mjs` would remove the reason for the mixed invocation, and this setting would become redundant rather than wrong.
