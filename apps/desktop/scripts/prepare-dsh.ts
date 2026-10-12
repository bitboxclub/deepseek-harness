/** Materialize the complete production runtime before publishing Desktop resources. */

import { packagingStep } from './packaging-step.mjs'
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { prepareRuntimeManifests } from './prepare-runtime-manifests.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
  resolveNpmRegistry,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
// 打包运行时的依赖仓库。上游把它放在 BUILD_ROOT 里，而 BUILD_ROOT 是每次运行新建的
// mkdtemp，于是【每次打包都要把整个运行时依赖闭包重下一遍】（约 533 个包，含 48 MB 的
// libreoffice-kit-wasm）。在慢速镜像链路上这一遍就必须重来，最终以 pnpm 默认 60s 的
// fetch 超时告终。
// 改为按目标平台持久化：首次下载后，后续打包直接复用（实测 12s vs 4m15s）。
// 放在 targets/<target>/ 下而不是跨目标共享，因为闭包含平台专属二进制包。
// 可用 DSH_DESKTOP_RUNTIME_STORE 覆盖。
const STORE_ROOT = process.env.DSH_DESKTOP_RUNTIME_STORE ?? join(BUILD_PATHS.root, 'runtime-store')
// Runtime dependency fetches must tolerate a slow registry mirror: the LibreOffice
// wasm tarball alone is 48 MB. These go into the generated npmrc (see runPnpm) —
// passing them as `--config.*` flags delivers strings to `AbortSignal.timeout`.
const RUNTIME_FETCH_TIMEOUT_MS = 1_800_000
const RUNTIME_FETCH_RETRIES = 6
const RUNTIME_FETCH_RETRY_MIN_MS = 20_000
const RUNTIME_FETCH_RETRY_MAX_MS = 300_000
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(BUILD_PATHS.electron, process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'linux' ? 'electron' : 'Electron.app/Contents/MacOS/Electron')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[], registry: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    // 慢速镜像链路自保，写在 npmrc 里而【不是】CLI 标志：
    // libreoffice-kit-wasm 单个 tarball 就有 48 MB，实测在 registry.npmmirror.com 的
    // CDN 上只有 ~73 KB/s（约需 11 分钟），远超 pnpm 默认 60s 的 fetch 超时；被掐断后
    // 3 次重试同样撞线，最终该包缺失，构建以 “missing required LibreOffice engine wasm” 收场。
    //
    // 为什么不能用 `--config.fetch-timeout=…`：CLI 的 `--config.X=值` 一律以字符串进入
    // pnpm，而该值会被直接喂给 `AbortSignal.timeout(number)`，于是抛
    // `TypeError: The "delay" argument must be of type number` 并在重试循环里反复失败
    // ——比原本的超时问题更糟（实测）。npmrc 里的值走 pnpm 的配置加载器，会按 schema
    // 转成数字，行为正确。
    //
    // 上界取 30 分钟：既容得下 48 MB @ 27 KB/s，又不会让一条挂死的连接把构建拖到无限期。
    writeFileSync(userConfig, [
      `fetch-timeout=${String(RUNTIME_FETCH_TIMEOUT_MS)}`,
      `fetch-retries=${String(RUNTIME_FETCH_RETRIES)}`,
      `fetch-retry-mintimeout=${String(RUNTIME_FETCH_RETRY_MIN_MS)}`,
      `fetch-retry-maxtimeout=${String(RUNTIME_FETCH_RETRY_MAX_MS)}`,
      '',
    ].join('\n'))
    const child = spawn(NODE, [
      '--expose-internals',
      PNPM,
      `--config.registry=${registry}`,
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: registry,
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        ...desktopNodeEnvironment(NODE, join(RUNTIME_ROOT, 'bin'), {}),
        PATH: `${join(RUNTIME_ROOT, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * Registries the runtime dependency install may fall back to, in order.
 *
 * The configured registry stays first — that is the deployment's choice, and this
 * build points it at registry.npmmirror.com. A mirror can be perfectly fine for
 * metadata while its binary CDN crawls, though, so the install needs somewhere
 * else to go. Measured on this host for the 48 MB `libreoffice-kit-wasm-0.1.5.tgz`:
 *
 * | registry                             | result                     |
 * |--------------------------------------|----------------------------|
 * | registry.npmmirror.com               | 0.2 MB in 40 s (~6 KB/s)   |
 * | registry.npmjs.org                   | 0 B in 40 s (unreachable)  |
 * | mirrors.cloud.tencent.com/npm        | 48 MB in 27 s (1.75 MB/s)  |
 * | repo.huaweicloud.com/repository/npm  | 48 MB in 27 s (1.76 MB/s)  |
 *
 * At 6 KB/s that one tarball needs ~2 hours, which no sane fetch timeout covers;
 * on the mirrors above it takes half a minute. Those two are the fallbacks, and
 * `DSH_DESKTOP_RUNTIME_REGISTRY` replaces them with a caller-chosen list
 * (comma-separated).
 *
 * Substituting the source cannot change what gets installed: the lockfile pins
 * every package by integrity and pnpm verifies each tarball against it. These
 * mirrors are plain npm registries serving the same bytes.
 */
const RUNTIME_FALLBACK_REGISTRIES = [
  'https://mirrors.cloud.tencent.com/npm',
  'https://repo.huaweicloud.com/repository/npm',
]

/**
 * @returns registry URLs to try in order; the configured registry first, then the
 * fallbacks, with duplicates removed.
 */
function runtimeRegistries(): string[] {
  const configured = process.env.DSH_DESKTOP_RUNTIME_REGISTRY
  const fallbacks = configured === undefined
    ? RUNTIME_FALLBACK_REGISTRIES
    : configured.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  const registries = [resolveNpmRegistry(process.env), ...fallbacks]
  return registries.filter((registry, index) => registries.indexOf(registry) === index)
}

/** Run one runtime pnpm command against every registry until one delivers. */
async function runRuntimePnpm(args: readonly string[]): Promise<void> {
  const registries = runtimeRegistries()
  const failures: unknown[] = []
  for (const [index, registry] of registries.entries()) {
    try {
      await runPnpm(args, registry)
      return
    } catch (error) {
      failures.push(error)
      const next = registries[index + 1]
      if (next === undefined) break
      console.warn(`desktop runtime: "pnpm ${args.join(' ')}" failed against ${registry}; retrying against ${next}`)
    }
  }
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, 'desktop runtime: pnpm failed against every configured registry')
}

/**
 * Whether the installed runtime tree carries the selected LibreOffice engine.
 *
 * Checked against the staging tree (before materialization) so a repair can still
 * re-run the install; the engine is an optional dependency, so a tarball pnpm
 * could not download is recorded as skipped and the install still exits 0.
 * @param engine - engine name from {@link selectOfficeEngine}.
 */
function officeEngineReady(engine: string): boolean {
  return existsSync(join(BUILD_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${engine}`, 'prebuilds.json'))
}

/**
 * Repair the packaged-app Office engine probe (upstream `libreoffice-kit@0.1.5` vs Electron ASAR).
 *
 * `installedPackageExists()` decides an engine package is on disk with
 * `lstatSync(dir, { throwIfNoEntry: false }) !== undefined`. Node returns `undefined` for a
 * missing path, but Electron's ASAR filesystem layer returns `null` (Electron 44's
 * `asar-fs-wrapper`: `if (!stat) { …; return null }`). Inside a packaged app every
 * `require.resolve.paths()` candidate lives in `app.asar`, so the probe reports EVERY engine as
 * "installed but incomplete": `resolveEngine` throws
 * `Installed LibreOfficeKit package is incomplete: …-linux-arm64-glibc` and never falls back to
 * the WASM engine the runtime actually ships (Linux native engines are not part of this
 * install). A plain directory returns `undefined` and behaves, which is why `runtime:smoke`
 * passes and only the packaged smoke fails.
 *
 * Relax the comparison to `!= null`, which excludes both values. Both copies of the function
 * are patched: `lib/index.js` (programmatic API) and `lib/cli.js` (`dsoffice`, used by the
 * Office skills and the smoke's CLI conversion). Fails loudly when the pattern is absent so a
 * future kit upgrade cannot silently restore the broken fallback.
 */
function patchOfficeKitEngineProbe(): void {
  const expected = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0'
  const replacement = 'lstatSync(join(directory, name), { throwIfNoEntry: false }) != null'
  for (const file of ['lib/index.js', 'lib/cli.js']) {
    const path = join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', 'libreoffice-kit', file)
    const source = readFileSync(path, 'utf8')
    if (source.includes(replacement)) continue
    if (!source.includes(expected)) {
      throw new Error(`desktop runtime: Office engine probe in ${file} does not match the expected pattern; verify the LibreOfficeKit engine fallback before packaging`)
    }
    writeFileSync(path, source.replace(expected, replacement))
  }
}

async function main(): Promise<void> {
  try {
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:reset', async () => {
      rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
      rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
      mkdirSync(STORE_ROOT, { recursive: true })
    })
    const release = desktopRelease()
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:stage-packages', async () => {
      copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
      cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
      createRuntimeProjectMetadata(BUILD_ROOT, release)
    })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:lockfile', () => runRuntimePnpm(['install', '--lockfile-only']))
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:install', () => runRuntimePnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile']))
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: desktopTargetPlatform(targetName).arch }
    const modules = join(BUILD_ROOT, 'node_modules')
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    // The engine is an OPTIONAL dependency of @deepseek-ai/libreoffice-kit, so pnpm records a
    // tarball it could not download as "skipped" and still exits 0: `runtime:install` reports
    // success with the engine absent, and only this check notices. The Host cannot serve Office
    // documents without it, so repair here — while the staging tree is still in place — instead
    // of failing at the end. Re-running install is cheap: every package already in the store is
    // reused, so only the missing tarball is fetched.
    if (!officeEngineReady(officeEngine)) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:repair-office-engine', async () => {
        for (const registry of runtimeRegistries()) {
          console.warn(`desktop runtime: LibreOffice engine "${officeEngine}" is missing after install; retrying against ${registry}`)
          await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile'], registry)
          if (officeEngineReady(officeEngine)) return
        }
      })
    }
    if (!officeEngineReady(officeEngine)) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:materialize-modules', async () => {
      cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
        recursive: true, dereference: true,
        filter: source => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
      })
    })
    // Must run before runtime:write-descriptor so the sealed inventory covers the patched bytes.
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:patch-office-kit', async () => patchOfficeKitEngineProbe())
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {
      throw new Error(`desktop runtime: missing required LibreOffice engine ${officeEngine}`)
    }
    if (process.platform === 'darwin') {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:dsh-native', () => signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, join(BUILD_PATHS.root, 'signature-cache')))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'sign:primary-native', () => signMacOSRuntime(join(RUNTIME_ROOT, 'primary-runtime'), resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, join(BUILD_PATHS.root, 'signature-cache')))
    }
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:primary-smoke', async () => smokePrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime')))
    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:write-descriptor', async () => writeDesktopRuntime(DSH_OUTPUT_ROOT, release, packageSet.packages.map(entry => entry.name), target))
    const descriptor = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-before-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    if (!process.argv.includes('--defer-runtime-smoke')) {
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:smoke', () => smokePreparedRuntime(DSH_OUTPUT_ROOT, NODE, RUNTIME_ROOT, descriptor))
      await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:verify-after-smoke', () => verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target))
    }
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    let cleaned = false
    const cleanup = (): void => {
      try { rmSync(BUILD_ROOT, { recursive: true, force: true }) }
      finally { rmSync(PNPM_BUILD_STATE, { recursive: true, force: true }) }
      cleaned = true
    }
    try { await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:cleanup', async () => cleanup()) }
    finally { if (!cleaned) cleanup() }
  }
}

await main()
