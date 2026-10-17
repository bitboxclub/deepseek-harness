# Agent Note: Desktop runtime dependency preparation over a slow mirror

Status: implemented

English | [中文](2026-10-12-desktop-runtime-dependency-preparation.zh.md)

## Problem

`prepare-dsh.ts` installs the packaged runtime's dependency closure — about 533 packages, including the 48 MB `libreoffice-kit-wasm` tarball — and it did so into a store directory created with `mkdtemp` under `BUILD_ROOT`. Every packaging run therefore downloaded the whole closure again. On a slow registry path that run is the run that fails: pnpm's default `fetch-timeout` of 60 s expires mid-tarball, three retries expire the same way, and the build dies.

The failure was also silent when it happened to the Office engine. `@deepseek-ai/libreoffice-kit` declares its engines as **optional** dependencies, so pnpm records a tarball it could not fetch as skipped and still exits 0. `runtime:install` reported success with the engine absent, and the build failed much later, at the packaged smoke, with a message that named the engine but not the download.

## Decision

Four changes, each answering one of those failures.

**The store persists per target.** `STORE_ROOT` is `DSH_DESKTOP_RUNTIME_STORE` or `BUILD_PATHS.root/runtime-store`, beside the target's other mutable directories instead of inside the per-run temporary tree. It is per target rather than shared, because the closure contains platform-specific binary packages. A warm store turns the install into a link pass.

**Fetch tolerances live in a generated `npmrc`.** `runPnpm` writes `fetch-timeout`, `fetch-retries`, `fetch-retry-mintimeout`, and `fetch-retry-maxtimeout` into the build state's `npmrc` (30 min, 6 retries, 20 s to 300 s backoff) before spawning pnpm. They cannot be passed as `--config.*` flags: a CLI `--config.X=value` reaches pnpm as a string, and `fetch-timeout` is handed straight to `AbortSignal.timeout(number)`, which rejects a string with `TypeError: The "delay" argument must be of type number` — inside the retry loop, so it fails harder than the timeout it was meant to fix. The `npmrc` path goes through pnpm's own configuration loader, which coerces by schema.

**The install falls back through an ordered registry list.** `runtimeRegistries()` puts the configured registry first, then two mirrors, with duplicates removed and `DSH_DESKTOP_RUNTIME_REGISTRY` replacing the fallback list. Substituting a registry cannot change what gets installed: the lockfile pins every package by integrity and pnpm verifies each tarball against it, and these are plain npm registries serving the same bytes.

**A missing engine is detected and repaired while the staging tree still exists.** `officeEngineReady(engine)` checks for the engine package's `prebuilds.json` after install. When it is absent, `runtime:repair-office-engine` re-runs the same frozen install against each registry in turn — cheap, because every package already in the store is reused — and the build fails immediately with the engine name if every attempt still leaves it missing, rather than at the packaged smoke.

## Alternatives considered

**Keep the temporary store and only raise the timeout.** It fixes the one tarball that motivated the change and nothing else: every run still re-downloads 533 packages, so the failure moves to wherever the slowest package happens to be that day.

**Pass the tolerances as `--config.fetch-timeout=…` flags.** Measured, and it fails: the value arrives as a string and `AbortSignal.timeout` throws on it, repeatedly, inside pnpm's retry loop.

**Point the registry at one faster mirror.** A single substitution is a deployment-wide choice that can be wrong for the next host. A configured registry followed by fallbacks keeps the deployment's choice first and makes the fallback a build-local detail.

**Treat the missing engine as a hard failure at `runtime:install`.** That reports the problem accurately but cannot distinguish "the mirror could not deliver it" from "the package set does not include it", and it throws away the work already in the store. The repair pass re-uses that work.

**Fail at the packaged smoke, where the absence first becomes visible.** That is the behaviour being replaced: the message names the engine, not the download, and it arrives after packaging and after the runtime tree has been materialized.

## Consequences

A warm store makes a repeat packaging run's dependency step take seconds instead of minutes; the first run still pays the download. The store lives under `apps/desktop/.desktop-build/targets/<target>/`, so it is ignored by Git and never shipped.

The tolerances are now part of the generated `npmrc`, which means a packaging run's network behaviour is configured in one place that is visible in the build state rather than implied by defaults.

The fallback list is a build-time convenience, not a distribution decision: when every registry fails, the error is an `AggregateError` carrying each attempt, and the caller still sees which registry was tried last. A deployment that must not contact the default mirrors sets `DSH_DESKTOP_RUNTIME_REGISTRY` to its own list.

An engine that is genuinely absent from the package set — rather than undeliverable — now fails with the same message as a download failure, after every registry has been tried. The distinction is not observable from the presence check, and the cost of the attempt is bounded by the store reuse.
