# Agent Note: Relaxing the LibreOfficeKit engine probe under ASAR

Status: implemented

English | [中文](2026-10-12-libreoffice-kit-asar-engine-probe.zh.md)

## Problem

`@deepseek-ai/libreoffice-kit` decides whether an engine package is installed with `(require.resolve.paths(name) ?? []).some((directory) => lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0)`. Node returns `undefined` for a path that does not exist. Electron's ASAR filesystem layer does not: its wrapper returns `null` when the archive has no such entry (`if (!stat) { …; return null }` in Electron 44's `lib/node/asar-fs-wrapper.ts`).

Inside a packaged application every `require.resolve.paths()` candidate for the engine lives in `app.asar`, so the probe reports every engine as "installed but incomplete". `resolveEngine` then throws `Installed LibreOfficeKit package is incomplete: …-linux-arm64-glibc` and never falls back to the WASM engine the runtime actually ships, because Linux native engines are not part of this install. The same code runs in `lib/index.js` (programmatic API) and `lib/cli.js` (`dsoffice`, used by the Office skills and the smoke's CLI conversion).

The defect is invisible before packaging: a plain directory returns `undefined` and the probe behaves. `runtime:smoke` passes, and only the packaged smoke fails.

## Decision

`prepare-dsh.ts` rewrites the comparison to `!= null`, which excludes both `undefined` and `null`, in both `lib/index.js` and `lib/cli.js` of the materialized runtime. The patch is idempotent (a file already carrying `!= null` is left alone) and it runs as the `runtime:patch-office-kit` step **before** `runtime:write-descriptor`, so the sealed inventory that `verifyRuntimeArchive` checks covers the patched bytes rather than the upstream ones.

A file that does not contain the expected `!== void 0` text raises an error naming the file and the fallback it guards, so a kit upgrade cannot silently restore the broken comparison. The check is on the exact source text, not on a behaviour probe: the byte pattern is the thing this decision depends on.

## Alternatives considered

**Patch at runtime with a module hook instead of on disk.** The Host already installs a `ModuleHooks` instance for the Office engine resolution, but the probe that fails runs inside the kit's own `require.resolve` path and in the `dsoffice` CLI child process, which does not share the Host's loader hooks. Editing the bytes covers both processes.

**Post-process only `lib/index.js`.** The CLI copy is what the smoke's conversion and the Office skills actually invoke, so patching one leaves the packaged failure in place for every document conversion.

**Upgrade `@deepseek-ai/libreoffice-kit`.** That is the real fix, and it is not available to this deployment: the version is pinned by the package set the Desktop runtime ships, and moving it would change the Office engine matrix for every platform in the same change. The patch is written to fail loudly on the next upgrade so the fix can be re-evaluated rather than silently carried.

**Patch through `patchedDependencies` in `pnpm-workspace.yaml`.** That is the repository's mechanism for changing a dependency's internals, and it would apply to development installs as well as packaged ones. It does not reach this tree: the runtime closure is installed by its own generated project under `BUILD_ROOT` with `--frozen-lockfile` and `--trust-lockfile`, and the packaged copy is materialized from that tree. A `patchedDependencies` entry would have to be threaded into the runtime project and its lockfile separately, which is a larger change than the defect justifies.

**Relax the probe by wrapping `lstatSync` in the kit's module scope.** Any wrapper would live in the same files that need patching, so the patch is smaller and states the change directly.

## Consequences

The packaged application falls back to the WASM engine for every engine the native probe cannot confirm, which is the behaviour the runtime intends: Linux native engines are not installed, and the WASM engine is.

The patch is a byte-level dependency on a third-party file. A version bump that renames the variable, reformats the comparison, or moves the function makes `runtime:patch-office-kit` fail with a message naming the file — which is the intended outcome, and the failing build is the signal to evaluate whether the upstream fix has landed.

Development installs keep the unpatched package. `pnpm dev:desktop` therefore runs against a differently-behaving kit than the packaged application does; the difference is confined to the engine-presence probe, and it is the reason this decision lives in an Agent Note rather than in a comment.
