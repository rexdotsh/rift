import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

function git(directory: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: directory, signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout))
      reject(new Error(String(stderr).trim() || error.message))
    })
  })
}

/** Moves a snapshot to `ref` with detached HEAD, like `git worktree add --detach <dir> <ref>`. */
export async function checkout(directory: string, ref: string, signal: AbortSignal): Promise<void> {
  await git(directory, ["switch", "--quiet", "--detach", ref], signal)
}

const shown = 5

function list(items: string[]) {
  const more = items.length - shown
  return items.slice(0, shown).join(", ") + (more > 0 ? ` and ${more} more` : "")
}

/**
 * Says what removing `directory` would lose, or returns undefined when nothing: changes `git status` reports
 * (untracked files included, ignored ones not), and commits on HEAD that no remote-tracking branch has and the
 * workspace it was copied from (`parent`) can't reach either. Unlike a Git worktree, a Rift workspace's commits live
 * only in its own `.git`. A workspace without a `.git` of its own is not a repository and has nothing to check.
 */
export async function unsaved(
  directory: string,
  parent: () => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!existsSync(path.join(directory, ".git"))) return
  const [status, head] = await Promise.all([
    git(directory, ["--no-optional-locks", "status", "--porcelain"], signal),
    git(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal).then(
      (output) => output.trim(),
      () => undefined,
    ),
  ])
  const changes = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
  const commits = head ? await unpushed(directory, head, parent, signal) : []
  const reasons = [
    changes.length > 0 && `uncommitted changes (${list(changes)}); commit or discard them`,
    commits.length > 0 &&
      `${commits.length} commit${commits.length === 1 ? "" : "s"} no remote branch has (${list(commits)}); push ${commits.length === 1 ? "it" : "them"}`,
  ].filter((reason) => typeof reason === "string")
  if (reasons.length === 0) return
  return `${directory} has ${reasons.join(", and ")}. Remove it with force to discard them.`
}

/** HEAD's commits that no remote-tracking branch has, unless a ref or HEAD in the parent reaches HEAD. */
async function unpushed(
  directory: string,
  head: string,
  parent: () => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string[]> {
  const commits = (await git(directory, ["log", "--format=%h %s", "HEAD", "--not", "--remotes"], signal))
    .split("\n")
    .filter(Boolean)
  if (commits.length === 0) return []
  const source = await parent()
  if (!source || !existsSync(path.join(source, ".git"))) return commits
  // Fails when the parent lacks the commit object, which also means it can't reach it.
  const reached = await git(source, ["rev-list", "--count", head, "--not", "--all"], signal).then(
    (count) => count.trim() === "0",
    () => false,
  )
  return reached ? [] : commits
}
