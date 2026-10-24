# Agent Note: Exercising the packaged runtime on a materialized archive copy

Status: implemented

English | [中文](2026-10-12-packaged-runtime-smoke-materialization.zh.md)

## Problem

`smoke-prepared-runtime.ts` runs the payload fixture and the Host against the prepared `dsh` root. When packaging finishes, that root lives inside `app.asar`, and the smoke's fixture runs as a Node-mode child of the packaged Electron binary. Every filesystem call there reaches the OS directly, so `readFileSync('…/app.asar/dsh/desktop-runtime.json')` fails with `ENOTDIR`: `app.asar` is a single file and the OS cannot traverse it.

Electron's ASAR wrapper exists to make that path work, and in this child it does not take over. The wrapper landed in a performance rewrite of Electron's `lib/node/asar-fs-wrapper.ts` that decides by `stat` whether a path is inside an archive, and the Node-mode child resolves the path through the OS before any wrapper decision. The archive itself is intact — `@electron/asar` lists all of its entries and `verifyRuntimeArchive` matches every byte against the sealed inventory — so the failure is in how the copy is read, not in what was written.

Materializing the archive exposed a second failure. `app-builder-lib` writes no `executable` flag in the archive header for entries it marks `unpacked`, so `extractAll` — which decides `chmod 755` from exactly that flag — lands every unpacked file at the default mode. The fixture then spawns the extracted `rg` and gets `EACCES`. The real `app.asar.unpacked` tree beside the archive carries the correct modes, because those are the files the packaged application itself executes.

## Decision

`materializeArchive` extracts the archive to a temporary directory beside it and the smoke runs against that copy instead of the archive. `restoreUnpackedModes` then mirrors the modes of `app.asar.unpacked` onto the extracted copy, file by file, so the copy carries the same permissions the packaged application runs with. Packed entries keep the flag `extractAll` already applied from the header; the two sources together are the complete truth about each file's mode.

The extraction is only performed when the prepared root is inside an archive (`asarArchiveOf`), so a plain staging directory — the `--dir` and `prepare-only` paths — is exercised in place with no copy and no extra work.

The order is deliberate: `verifyRuntimeArchive` runs before the copy is used, so the bytes the smoke exercises have already been matched against the sealed inventory. Materialization does not weaken the integrity claim; it changes which filesystem the same verified bytes are read through.

## Alternatives considered

**Skip the smoke for packaged artifacts.** The packaged smoke is the only check that runs the fixture against what actually ships — the `--dir` path exercises a staging tree whose layout differs from the installed one. Dropping it would have removed the only check that runs the fixture against the installed layout.

**Pass the archive contents through `@electron/asar` in the fixture.** The fixture would have to stop using ordinary `readFileSync` and `spawn`, which is exactly the behaviour the packaged application relies on. A fixture that reads through the archive API cannot observe a mode-bit or path-resolution defect.

**Set `ELECTRON_NO_ASAR` and read the unpacked tree.** That disables the ASAR layer for the whole process, including the Host child the smoke also starts, so the run would no longer resemble the packaged application.

**Chmod only the `rg` binary.** `app.asar.unpacked` carries twelve executables — the ripgrep binary, the Office wasm asset, two sherpa `.so` files and its `.node`, a koffi `.node`, and several `.cjs` helpers. Fixing the one that failed leaves the next spawn the fixture adds to fail the same way, which is how this defect first appeared.

**Rely on `extractAll` and patch its output afterwards.** `extractAll` reads the header flag, and the header flag is what is missing; a post-pass over the header cannot recover a mode the header never recorded.

## Consequences

The packaged smoke costs one extraction of the application archive (about 1.5 s for the 195.7 MB archive with 23 215 entries on the packaging host) and a directory walk over 889 files, on the packaging path only.

Two Electron behaviours are now recorded here rather than rediscovered: the Node-mode child resolves paths through the OS instead of the ASAR wrapper, and the archive header does not carry execute permission for unpacked entries. Both are properties of Electron 44 and `app-builder-lib` 26.15.3 as installed; a future version that changes either makes the materialization unnecessary but not harmful.

The materialized copy is removed in the smoke's `finally` block, so a failed run leaves no tree of unpacked runtime files beside the artifacts.

The permissions the copy receives come from `app.asar.unpacked`, so the smoke would not detect a defect where `app-builder-lib` wrote a wrong mode into that tree. That tree is what the installed application executes, so such a defect would be a packaging bug in electron-builder rather than in this repository, and the packaged smoke's payload checks would fail on it directly.
