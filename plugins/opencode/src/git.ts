import { execFile } from "node:child_process"

/** Moves a snapshot to `ref` with detached HEAD, like `git worktree add --detach <dir> <ref>`. */
export function checkout(directory: string, ref: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["switch", "--quiet", "--detach", ref], { cwd: directory, signal }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      reject(new Error(String(stderr).trim() || error.message))
    })
  })
}
