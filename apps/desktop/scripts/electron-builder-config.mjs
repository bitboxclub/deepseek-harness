import { readInstallerLocales, renderInstallerStrings } from './installer-locales.mjs'
import { officePackageDirectories } from '../../../scripts/libreoffice-packages.mjs'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSDiskImageSignature, verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { resolveDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { desktopArtifactOutput, desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature, signWindowsCode } from './windows-runtime-signature.mjs'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from './windows-asar-unpack.mjs'
import { recordPackagingEvent } from './packaging-run.mjs'
import {
  resolveMacOSAppUpdateFeed,
  verifyMacOSAppUpdateConfig,
  writeMacOSAppUpdateConfig,
} from './macos-app-update-config.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Verified private dsh tree for installed-update qualification; ordinary releases use the target tree.
 * @param {string | undefined} preparedRuntimeVersion - Version that private tree declares, which qualification rewrites away from the product version.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
  preparedRuntimeVersion = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  const skipNotarization = env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION === '1'
  if (env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_MACOS_SKIP_NOTARIZATION)) {
    throw new Error('desktop package: DSH_DESKTOP_MACOS_SKIP_NOTARIZATION must be 0 or 1')
  }
  if (skipNotarization && (unsigned || resolvedPlatform !== 'darwin')) throw new Error('Skipping notarization requires a signed macOS build')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  const packagesLinux = resolvedPlatform === 'linux'
  // A Linux target publishes no update feed and answers to no policy service, so it carries no
  // mandatory-update policy. Omitting the field is what disables enforcement: the runtime resolves a
  // missing policy to undefined.
  const policy = packagesLinux || packagesMacOS && unsigned ? undefined : resolveDesktopPolicyEnvironment(env)
  if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()
  const macOSSigning = packagesMacOS && !unsigned ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS && !unsigned && !skipNotarization) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch), env)
  const output = desktopArtifactOutput(buildPaths, { unsigned, skipNotarization })
  let primaryRuntimeDestination
  let dshDestination
  let windowsCode = []
  const unpack = ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg',
    `**/node_modules/@deepseek-ai/libreoffice-kit-${resolvedPlatform}-${resolvedArch}/**/*`]
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => {
          for (const [sourceRoot, destinationRoot] of [[join(buildPaths.runtime, 'primary-runtime'), primaryRuntimeDestination], [buildPaths.dsh, dshDestination]]) {
            if (destinationRoot !== undefined && await preserveWindowsRuntimeSignature(path, {
              sourceRoot, destinationRoot, runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
            })) return true
          }
          return false
        },
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  // Linux is a locally-built community target: no auto-update feed is published for it.
  const update = unsigned || packagesLinux ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  // electron-builder merges extraMetadata into the packaged manifest, so a build version here reaches
  // the artifact names, the update feed, and the installed app.getVersion() the updater compares against.
  const productVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
  const buildVersion = resolveDesktopBuildVersion(env, productVersion)
  if (update?.channel === 'latest' && buildVersion.includes('-')) throw new Error('desktop package: latest requires a stable version')
  const packaged = resolveDesktopBuildCommit(env)
  return {
    appId,
    protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }],
    extraMetadata: {
      dshDesktopAppId: appId,
      dshDesktopUpdateChannel: update?.channel ?? 'nightly',
      ...(policy === undefined ? {} : { dshMandatoryUpdatePolicy: policy }),
      ...buildVersion === productVersion ? {} : { version: buildVersion },
      ...packaged === undefined ? {} : { dshBuildCommit: packaged.commit, dshBuildDirty: packaged.dirty },
    },
    productName: 'DeepSeek Harness',
    // The default copyright uses author.name; this line names the product instead.
    copyright: `Copyright © ${new Date().getFullYear()} \${productName}`,
    // Unsigned builds carry their own suffix so a shared file can never pass for a release artifact.
    artifactName: `deepseek-harness-\${version}-\${os}-\${arch}${output.suffix}.\${ext}`,
    directories: { output: output.directory },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      if (resolvedPlatform !== 'win32') return true
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      await writeFile(join(buildPaths.root, 'installer-ui', 'strings.nsh'), renderInstallerStrings(readInstallerLocales()), 'utf8')
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(buildPaths.root, 'installer-ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/welcome/**/*',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-platform-account.cjs',
      'lib/preload-update-dialog.cjs',
      'lib/preload-welcome.cjs',
      'renderer/**/*',
      'package.json',
      '!node_modules/**/*.{js,cjs,mjs,ts,cts,mts,css}.map',
      '!node_modules/**/*.tsbuildinfo',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: unpack,
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      // Window and about-panel icon. Linux reuses the 512 px entry of the sized set below, so one
      // committed bitmap serves both the window icon and the launcher icon; Windows keeps its
      // multi-size `icon-windows.png`.
      {
        from: fileURLToPath(new URL(
          packagesLinux ? '../resources/icons/512x512.png' : '../resources/icon-windows.png',
          import.meta.url,
        )),
        to: 'icon.png',
      },
      // Tray bitmaps. Windows takes the multi-size ICO; Linux panels take a PNG, and `nativeImage`
      // picks the sibling `tray@2x.png` on HiDPI displays by itself. macOS keeps the Dock.
      ...(packagesWindows ? [{ from: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)), to: 'tray.ico' }] : []),
      ...(packagesLinux ? [
        { from: fileURLToPath(new URL('../resources/tray.png', import.meta.url)), to: 'tray.png' },
        { from: fileURLToPath(new URL('../resources/tray@2x.png', import.meta.url)), to: 'tray@2x.png' },
      ] : []),
    ],
    mac: {
      icon: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      // macOS matches the application locale against this bundle, not Electron Framework resources.
      extendInfo: {
        CFBundleLocalizations: ['en', 'zh_CN', 'ja', 'es', 'fr', 'de', 'ru', 'pt'],
        NSMicrophoneUsageDescription: 'DeepSeek Harness uses your microphone to transcribe speech into message drafts.',
      },
      // Ad-hoc signing keeps the modified Electron executable runnable without a Developer ID.
      identity: unsigned ? '-' : macOSSigning?.signingIdentity,
      forceCodeSigning: !unsigned,
      hardenedRuntime: true,
      entitlements: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      entitlementsInherit: fileURLToPath(new URL('./macos-entitlements.plist', import.meta.url)),
      // Prepared runtime files retain their signatures; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '\\.pak$'],
      notarize: !unsigned && !skipNotarization,
      target: unsigned ? ['dmg'] : ['dmg', 'zip'],
    },
    dmg: {
      format: 'ULMO',
      sign: !unsigned,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      const office = await officePackageDirectories(buildPaths.dsh, { platform: resolvedPlatform, arch: resolvedArch })
      const patterns = office.map(directory => `**/${relative(buildPaths.dsh, directory).split(sep).join('/')}/**/*`)
      const existing = context.packager.config.asarUnpack ?? []
      context.packager.config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing), ...patterns]
      if (packagesWindows) windowsCode = await prepareWindowsAsarUnpack(context, buildPaths.dsh)
      if (windowsSigner !== undefined) {
        primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
        dshDestination = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'dsh')
      }
      if (policy === undefined) return
      const { resolveDesktopPolicyConfig } = await import('../lib/types/mandatory-update-policy.js')
      resolveDesktopPolicyConfig(policy)
    },
    afterPack: async context => {
      const { verifyDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      if (resolvedPlatform === 'darwin' && update !== undefined) {
        await writeMacOSAppUpdateConfig(resourcesDir, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      // The bundled runtime declares whichever version prepared it: the product version for an ordinary
      // release, and a rewritten one for installed-update qualification.
      await verifyDesktopRuntime(buildPaths.dsh,
        preparedRuntimeVersion ?? productVersion, { platform: resolvedPlatform, arch: resolvedArch })
      // Unsigned Windows builds skip electron-builder's afterSign hook.
      if (packagesWindows && unsigned) await verifyWindowsAsarUnpack(buildPaths.dsh, resourcesDir, windowsCode)
    },
    afterSign: async context => {
      if (windowsSigner !== undefined) {
        await signWindowsCode(context.appOutDir, {
          thumbprint: new X509Certificate(await readFile(env.DSH_DESKTOP_WINDOWS_CER_FILE)).fingerprint.replaceAll(':', ''),
          sign: windowsSigner,
          record: event => recordPackagingEvent(env.DSH_DESKTOP_PACKAGING_RUN_DIR, event),
        })
        await verifyWindowsAsarUnpack(buildPaths.dsh, context.packager.getResourcesDir(context.appOutDir), windowsCode)
      }
      if (context.electronPlatformName !== 'darwin' || unsigned) return
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      if (update !== undefined) {
        await verifyMacOSAppUpdateConfig(appPath, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (unsigned || !artifact.file.endsWith('.dmg')) return
      if (skipNotarization) {
        verifyMacOSDiskImageSignature(artifact.file, macOSSigning ?? resolveMacOSSigningEnvironment(env))
        return
      }
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      // A sized icon *directory*, not a single PNG. electron-builder installs each entry into
      // /usr/share/icons/hicolor/<N>x<N>/apps/, and desktop environments only resolve an icon whose
      // size appears in the installed index.theme `Directories` list. Each `<N>x<N>.png` here is
      // rasterized per size from resources/icon.svg by `pnpm run render:app-icons`.
      icon: fileURLToPath(new URL('../resources/icons', import.meta.url)),
      // The command name, the installed PNG stem, and the .desktop file stem all derive from this.
      // electron-builder's Linux default is the sanitized package name, which for
      // '@deepseek-ai/dsh-desktop' is '@deepseek-aidsh-desktop' — unusable as a command.
      executableName: 'deepseek-harness',
      // StartupWMClass must equal Electron's app_id, which comes from package.json `desktopName`.
      syncDesktopName: true,
      // The Kylin and UOS desktops are Debian-based, so a deb is the portable delivery form.
      target: ['deb'],
      maintainer: 'DeepSeek Harness local build',
      synopsis: 'DeepSeek Harness',
      description: 'DeepSeek Harness desktop client (local Linux build).',
      category: 'Development;Utility;',
    },
    deb: {
      // afterInstall and afterRemove belong to DebOptions; the linux node's schema rejects them.
      // Both scripts are electron-builder's default templates plus the /usr/bin/dsh alternative.
      afterInstall: fileURLToPath(new URL('../installer/linux-after-install.sh', import.meta.url)),
      afterRemove: fileURLToPath(new URL('../installer/linux-after-remove.sh', import.meta.url)),
      // Self-contained delivery: the runtime ships in the package, so this declares only the system
      // libraries Electron itself needs. These are the Debian-era package names Kylin V10 SP1
      // provides; Ubuntu 24.04 renamed libasound2 to libasound2t64.
      depends: [
        'libgtk-3-0',
        'libnotify4',
        'libnss3',
        'libxss1',
        'libxtst6',
        'xdg-utils',
        'libatspi2.0-0',
        // Supplying `depends` replaces electron-builder's default list, which includes libuuid1;
        // dropping it would leave Chromium's uuid lookup unsatisfied on a minimal install.
        'libuuid1',
        'libsecret-1-0',
        'libasound2',
        'libgbm1',
        'libdrm2',
        'libxkbcommon0',
        'libcups2',
        'libpango-1.0-0',
      ],
      priority: 'optional',
    },
    nsis: {
      uninstallDisplayName: '${productName}',
      installerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      uninstallerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      include: fileURLToPath(new URL('./installer.nsh', import.meta.url)),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      installerLanguages: readInstallerLocales().map(locale => locale.id),
      differentialPackage: true,
    },
    detectUpdateChannel: false,
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: update.channel }],
  }
}
