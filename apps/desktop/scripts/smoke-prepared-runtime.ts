/** Check payloads and Host boot with private native-cache and Harness directories. */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runtimeArchivePath } from '../../desktop-host/src/office-engine.ts'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'
import { smokeDesktopRuntime } from './smoke-runtime.ts'
import { verifyRuntimeArchive } from './verify-runtime-archive.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { extractAll } = builderRequire('@electron/asar') as { extractAll: (archive: string, destination: string) => void }

/**
 * Return the application archive a prepared root lives inside, when it does.
 * @param root - Prepared or archived dsh directory.
 * @returns The ASAR file path, or undefined when the root is a plain directory.
 */
function asarArchiveOf(root: string): string | undefined {
  const parent = dirname(root)
  return basename(parent).endsWith('.asar') ? parent : undefined
}

/**
 * Restore the executable bits the ASAR header does not carry for unpacked entries.
 *
 * app-builder-lib writes no `executable` flag for files it marks `unpacked`, so
 * `extractAll` lands every one of them with the default 0644 — the packaged
 * ripgrep binary then fails to spawn with EACCES. The real `app.asar.unpacked`
 * tree beside the archive keeps the modes the packaged application itself runs
 * from, so mirror them onto the materialized copy; packed entries already carry
 * their flag and `extractAll` applies it during extraction.
 *
 * @param materialized - Extracted archive root.
 * @param unpacked - The `app.asar.unpacked` directory beside the archive.
 */
function restoreUnpackedModes(materialized: string, unpacked: string): void {
  if (!existsSync(unpacked)) return
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()!
    const directory = relative === '' ? materialized : join(materialized, relative)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        pending.push(name)
        continue
      }
      // Only regular files carry modes worth restoring; extractAll already made
      // header `link` entries into symlinks, whose permissions the OS ignores.
      if (!entry.isFile()) continue
      try {
        const source = lstatSync(join(unpacked, name))
        if (!source.isFile()) continue
        chmodSync(join(materialized, name), source.mode & 0o777)
      } catch {
        // Not an unpacked entry: extractAll already applied the header flag.
      }
    }
  }
}

/**
 * Extract one application archive to a physical directory beside it.
 * @param archive - Application ASAR file, with its unpacked directory beside it.
 * @param entry - Archive entry the prepared root names.
 * @returns The physical root the smoke exercises.
 */
async function materializeArchive(archive: string, entry: string): Promise<string> {
  const destination = await mkdtemp(join(dirname(archive), 'dsh-asar-smoke-'))
  extractAll(archive, destination)
  restoreUnpackedModes(destination, join(dirname(archive), 'app.asar.unpacked'))
  return join(destination, entry)
}

/**
 * Exercise real runtime files and Host composition, including an ASAR root when packaged.
 * @param root Prepared or archived dsh directory.
 * @param node Target Electron executable.
 * @param resourcesRuntime External runtime directory beside the archive.
 * @param descriptor Runtime descriptor already verified against the selected target, which may differ from the build host.
 * @returns Resolves after archive integrity, payload checks, Host startup, Office conversion and teardown.
 */
export async function smokePreparedRuntime(
  root: string, node: string, resourcesRuntime: string, descriptor: DesktopRuntimeDescriptor,
): Promise<void> {
  const cache = await mkdtemp(join(tmpdir(), 'desktop-native-smoke-'))
  const environment = { ...scrubWindowsSigningEnvironment(process.env), NODE_OPTIONS: '',
    NARB_NATIVE_CACHE_DIR: cache, NARB_DISABLE_NATIVE_CACHE: '0' }
  // A packaged root lives inside app.asar — a single file the OS cannot traverse. Electron's
  // patched fs reads through it in a GUI process, but this smoke's Node-mode child resolves
  // the path through the OS and fails with ENOTDIR before the first read (observed with
  // Electron 44.7.0 on Linux). The archive's bytes are already proven against the sealed
  // descriptor by verifyRuntimeArchive below, so materialize a physical copy and exercise
  // that; a plain staging directory needs no copy.
  const archive = asarArchiveOf(root)
  const materialized = archive === undefined ? undefined : await materializeArchive(archive, basename(root))
  try {
    const officeArchive = runtimeArchivePath(root)
    if (officeArchive !== undefined) await verifyRuntimeArchive(officeArchive, descriptor)
    const smokeRoot = materialized ?? root
    const { stdout } = await promisify(execFile)(node, [
      '--expose-internals', resolve(import.meta.dirname, '../tests/fixtures/runtime-payload-smoke.mjs'), smokeRoot, resourcesRuntime,
    ], { timeout: 120_000, windowsHide: true,
      env: desktopNodeEnvironment(node, join(resourcesRuntime, 'bin'), environment) })
    process.stdout.write(stdout)
    await smokeDesktopRuntime(smokeRoot, node, descriptor, environment, resourcesRuntime)
  } finally {
    if (materialized !== undefined) await rm(dirname(materialized), { recursive: true, force: true })
    await rm(cache, { recursive: true, force: true })
  }
}
