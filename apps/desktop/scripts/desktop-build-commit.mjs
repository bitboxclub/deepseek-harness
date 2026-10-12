/**
 * Carry the commit a build came from into its artifacts.
 *
 * A build that reaches a colleague or a test feed is not reachable from a tag,
 * so the only way back to its sources is what the build recorded about itself.
 * The packaging entry reads the checkout once and passes the result to every
 * child process, which run against a build tree rather than a checkout.
 */

import { execFileSync } from 'node:child_process'

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV = 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV = 'DSH_DESKTOP_BUILD_DIRTY'

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * @param {string} repositoryRoot - Directory to inspect.
 * @returns {{ commit: string, dirty: boolean } | undefined} The commit being packaged and whether its tree was modified, or undefined when the directory is not a git checkout (e.g. a released source archive).
 */
export function readDesktopBuildCommit(repositoryRoot) {
  try {
    // stdio 必须显式给全：execFileSync 同步变体默认把子进程 stderr 透传到父进程，
    // 非 git 目录下 git 的 "fatal: not a git repository" 会污染构建日志。
    const git = (args) => execFileSync('git', args, {
      cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return {
      commit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
    }
  }
  catch {
    // 源码归档（tar 包）没有 .git，无法记录提交信息；调用方按缺省处理。
    return undefined
  }
}

/**
 * Resolve the commit a parent packaging process recorded.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ commit: string, dirty: boolean } | undefined} The packaged commit, or undefined outside a packaging run.
 */
export function resolveDesktopBuildCommit(env) {
  const commit = env[DESKTOP_BUILD_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`desktop build commit: ${DESKTOP_BUILD_COMMIT_ENV} must be a commit hash`)
  const dirty = env[DESKTOP_BUILD_DIRTY_ENV]?.trim()
  if (dirty !== undefined && dirty !== '' && dirty !== '0' && dirty !== '1') {
    throw new Error(`desktop build commit: ${DESKTOP_BUILD_DIRTY_ENV} must be 0 or 1`)
  }
  return { commit, dirty: dirty === '1' }
}

/**
 * Describe the packaged commit as the environment variables child processes read.
 * @param {{ commit: string, dirty: boolean }} packaged - Commit and tree state to pass down.
 * @returns {Record<string, string>} Variables to merge into a child environment.
 */
export function desktopBuildCommitEnvironment(packaged) {
  return {
    [DESKTOP_BUILD_COMMIT_ENV]: packaged.commit,
    [DESKTOP_BUILD_DIRTY_ENV]: packaged.dirty ? '1' : '0',
  }
}
