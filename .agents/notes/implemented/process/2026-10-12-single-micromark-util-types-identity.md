# Agent Note: One `micromark-util-types` identity across the Markdown closure

Status: implemented

English | [中文](2026-10-12-single-micromark-util-types-identity.zh.md)

## Problem

`pnpm-lock.yaml` resolved `micromark-util-types` twice: `2.0.2` for `mdast-util-from-markdown@2.0.3` and `micromark-extension-gfm@3.0.0`, and `2.0.3` for the `micromark@4.0.2` core, every GFM sub-extension, the math extension, and the factory packages. Every consumer declares `^2.0.0`, so the split came from resolution, not from a conflicting requirement.

TypeScript treats the two copies as unrelated types. `packages/client/ui-primitives/src/markdown/parse.ts` builds an extension array from the CJK extension (reaching `2.0.3` through a direct dependency) and passes it to `fromMarkdown` (typed against `2.0.2`), which fails with `TS2769` and a comparison chain that ends at `'listItem' is not assignable to type 'keyof TokenTypeMap'`. The failure is in `build:lib`, so nothing in the repository builds.

The split arrived with a lockfile refresh that also moved Electron from 44.0.0 to 44.7.0; the branch never ran a full `build:lib` afterwards, so the first full build in this sequence was also the first to see it.

## Decision

`pnpm-workspace.yaml` overrides `micromark-util-types` to `2.0.3`, the version the runtime core and all extensions already run on, and the lockfile resolves to one copy.

The override lives in `pnpm-workspace.yaml` rather than in the root `package.json`: pnpm 11 no longer reads a `pnpm` field there and reports it as ignored, so an override placed there has no effect and produces a warning on every invocation.

## Alternatives considered

**Pin `ui-primitives`' own dependency to `2.0.2`.** The extension array mixes the CJK extension with `math()`, which comes from a `2.0.3` package; pinning the direct dependency leaves the mismatch in the same array.

**Upgrade the packages that still resolve `2.0.2`.** They are the two entry packages of the closure, and moving them changes the Markdown pipeline for the Web client, the parser used by the documentation gates, and every package that renders Markdown. The type-identity split is a resolution artefact, not a signal that those versions are wrong.

**Leave the split and cast at the call site.** A cast would silence the only mechanism that reports the mismatch. The two copies are structurally different — `2.0.3` adds token types `2.0.2` does not have — so the array being passed is genuinely not the type `fromMarkdown` was compiled against.

## Consequences

One `micromark-util-types` copy remains in the store and the closure resolves without warnings. The override is a standing instruction in `pnpm-workspace.yaml`; it stays after the entry packages catch up, which is harmless because they accept `^2.0.0`, and removing it later is a lockfile refresh away.

The lockfile diff for this change is larger than the override itself: pnpm re-resolved the portion of the graph that reaches `micromark-util-types`, and the Electron move from 44.0.0 to 44.7.0 contributed its own entries in the same file.

A stale `tsconfig.tsbuildinfo` from an earlier failed build replays the old diagnostic even after the tree is consistent, because `tsc -b` judges a source file unchanged and does not re-read the replaced declaration files. Any change to this part of the dependency graph requires deleting the incremental build state before the result can be trusted.
