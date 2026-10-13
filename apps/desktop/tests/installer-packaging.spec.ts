import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { Arch, Platform } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

describe('installer preparation preserves application dependencies', () => {
  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('keeps electron-builder responsible for node_modules on %s', async (platform) => {
    execute.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      // Windows carries the multi-size ICO; Linux the PNG pair. Neither belongs to these targets.
      const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
      expect(config.extraResources.filter(resource => resource.to === 'tray.png' || resource.to === 'tray@2x.png')).toEqual([])
      if (platform === 'win32') {
        expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
      } else {
        expect(trayIcon).toBeUndefined()
      }
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('ships the sized icon set and the tray PNG pair the Linux desktop reads', async () => {
    const { readdirSync } = await import('node:fs')
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_TARGET_PLATFORM: 'linux',
      DSH_DESKTOP_TARGET_ARCH: 'arm64',
    }, 'linux', 'arm64')
    // A single PNG lands in hicolor/<its own pixel size>/apps/, and a directory is the only way to
    // install the standard size set the desktop looks up. electron-builder names each entry
    // `<N>x<N>.png` and matches it by that pattern, so the directory must hold exactly that shape.
    // readdirSync is unordered, hence the sort before comparing the size set.
    const sizes = readdirSync(config.linux.icon).map(name => Number(name.slice(0, name.indexOf('x')))).sort((a, b) => a - b)
    expect(sizes).toEqual([16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512])
    for (const name of readdirSync(config.linux.icon)) {
      const edge = Number(name.slice(0, name.indexOf('x')))
      const png = readFileSync(new URL(`../resources/icons/${name}`, import.meta.url))
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([edge, edge])
    }
    // The .desktop Icon= key, the installed PNG stem, and the command name all come from executableName.
    expect(config.linux.executableName).toBe('deepseek-harness')
    // Without syncDesktopName the .desktop file keeps the product name while Electron's app_id comes
    // from desktopName, so the window never matches its launcher entry.
    expect(config.linux.syncDesktopName).toBe(true)
    expect(config.linux.target).toEqual(['deb'])
    // The tray bitmaps are the second half of the same requirement: without them the panel item is
    // absent and a hidden window has no way back. The PNG carries its own size, so read it back.
    const tray = new Map<string, [number, number]>()
    for (const resource of config.extraResources) {
      if (resource.to !== 'tray.png' && resource.to !== 'tray@2x.png') continue
      const png = readFileSync(resource.from)
      tray.set(resource.to, [png.readUInt32BE(16), png.readUInt32BE(20)])
    }
    expect([...tray]).toEqual([['tray.png', [22, 22]], ['tray@2x.png', [44, 44]]])
    // The deb knows nothing about PATH: without a maintainer script linking
    // /usr/bin/dsh to the packaged runtime/cli/bin/dsh the CLI stays unreachable
    // from a terminal. after-install must add it, after-remove must drop it again.
    // The keys live under DebOptions — the linux node's schema rejects them.
    const installScript = readFileSync(config.deb.afterInstall, 'utf8')
    const removeScript = readFileSync(config.deb.afterRemove, 'utf8')
expect(installScript).toContain("ln -sf '/opt/\${sanitizedProductName}/resources/runtime/cli/bin/dsh' '/usr/bin/dsh'")
    expect(installScript).toContain("'/usr/bin/\${executable}'")
    expect(removeScript).toContain("rm -f '/usr/bin/dsh'")
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe('deepseek-harness-${version}-${os}-${arch}-unsigned.${ext}')
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})
