/** Run the complete repository build and bind its client artifacts to their public environment. */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CLIENT_BUILD_RECORD_PATH,
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Run one package script through the package manager that invoked this build. */
function runScript(script: string, environment: NodeJS.ProcessEnv): void {
  const invocation = pnpmInvocation(['run', script], environment)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: resolve(import.meta.dirname, '..'),
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`build: ${script} exited with ${String(result.status ?? result.signal)}`)
  }
}

/** Run the full build selected by `--profile` or `DSH_BUILD_CLIENT_PROFILE`. */
function main(): void {
  const { values } = parseArgs({
    // `pnpm run build:official -- --no-source-maps` forwards the separator itself, the same
    // convention package-target.ts handles; parseArgs would read everything after it as
    // positional arguments, so drop the separator before parsing.
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: { profile: { type: 'string' }, 'no-source-maps': { type: 'boolean', default: false } },
    allowPositionals: false,
  })
  const root = resolve(import.meta.dirname, '..')
  // A packaging build emits no source maps. They are a development artifact: the runtime file
  // policy (apps/desktop/scripts/runtime-file-policy.ts) already filters them out of the runtime
  // tree, so producing them spends the IO of tens of thousands of small files across tsc emit,
  // npm pack, pnpm install, and cpSync for nothing — which a build compiled on the machine that
  // runs it cannot spare. `--no-source-maps` switches the emit off in tsc and vite; a build
  // without it behaves and emits exactly as before, and TypeScript notices the option change, so
  // alternating the two never leaves a stale lib/.
  if (values['no-source-maps']) process.env.DSH_BUILD_EMIT_MAPS = '0'
  const repositoryEnvironment = repositoryClientBuildEnvironment(root, process.env)
  const profile = values.profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR]
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, profile)
  const buildEnvironment = clientBuildProcessEnvironment(process.env, clientEnvironment)

  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  runScript('build:native-system', buildEnvironment)
  runScript(values['no-source-maps'] ? 'build:lib:packaging' : 'build:lib', buildEnvironment)
  runScript('build:web', buildEnvironment)
  const record = writeClientBuildRecord(root, clientEnvironment)
  console.log(
    `build: recorded ${String(record.artifacts.fileCount)} client artifact(s) with ${String(Object.keys(record.environment).length)} public value(s)`,
  )
}

if (import.meta.main) main()
