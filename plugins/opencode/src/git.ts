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

/** One repository in a workspace, the workspace's own or an initialized submodule's, as it stood when read. */
interface Repository {
  /** Relative to the workspace root; empty for the workspace itself. */
  path: string
  head: string | undefined
  status: string
}

async function read(root: string, relative: string, signal: AbortSignal): Promise<Repository> {
  const directory = path.join(root, relative)
  const [head, status] = await Promise.all([
    git(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal).then(
      (output) => output.trim(),
      () => undefined,
    ),
    // Explicit, so repository or user config (status.showUntrackedFiles=no, submodule.<name>.ignore=all) can't hide
    // work. Ignored files still don't count, as with `git worktree remove`.
    git(
      directory,
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
      signal,
    ),
  ])
  return { path: relative, head, status }
}

/** The workspace's repository and its initialized submodules, nested ones included. */
async function snapshot(directory: string, signal: AbortSignal): Promise<Repository[]> {
  const submodules = (
    await git(directory, ["submodule", "foreach", "--quiet", "--recursive", `printf '%s\\0' "$displaypath"`], signal)
  )
    .split("\0")
    .filter(Boolean)
  return Promise.all(["", ...submodules].map((relative) => read(directory, relative, signal)))
}

const shown = 5

function list(items: string[]) {
  const more = items.length - shown
  return items.slice(0, shown).join(", ") + (more > 0 ? ` and ${more} more` : "")
}

/**
 * Says what removing `directory` would lose, or returns undefined when nothing: changes `git status` reports (untracked files included, ignored ones
 * not), and commits on HEAD that no remote-tracking branch has and the matching repository in the workspace it was
 * copied from (`parent`) can't reach either, in the workspace's repository and each initialized submodule. Unlike a
 * Git worktree, a Rift workspace's commits live only in its own `.git`. A workspace without a `.git` of its own is not
 * a repository and has nothing to check. Fails when a repository can't be read.
 */
export async function unsaved(
  directory: string,
  parent: () => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!existsSync(path.join(directory, ".git"))) return
  const repositories = await snapshot(directory, signal)
  let source: Promise<string | undefined> | undefined
  const reaches = async (repository: Repository, head: string) => {
    const root = await (source ??= parent())
    const counterpart = root && path.join(root, repository.path)
    if (!counterpart || !existsSync(path.join(counterpart, ".git"))) return false
    // Fails when the counterpart lacks the commit object, which also means it can't reach it.
    return git(counterpart, ["rev-list", "--count", head, "--not", "--all"], signal).then(
      (count) => count.trim() === "0",
      () => false,
    )
  }
  const unpushed = async (repository: Repository) => {
    const head = repository.head
    if (!head) return []
    const directoryOf = path.join(directory, repository.path)
    const commits = (await git(directoryOf, ["log", "--format=%h %s", head, "--not", "--remotes"], signal))
      .split("\n")
      .filter(Boolean)
    if (commits.length === 0 || (await reaches(repository, head))) return []
    return commits.map((commit) => (repository.path ? `${repository.path}: ${commit}` : commit))
  }
  const changes = repositories.flatMap((repository) =>
    repository.status
      .split("\n")
      .filter(Boolean)
      .map((line) => path.join(repository.path, line.slice(3))),
  )
  const commits = (await Promise.all(repositories.map(unpushed))).flat()
  const reasons = [
    changes.length > 0 && `uncommitted changes (${list(changes)}); commit or discard them`,
    commits.length > 0 &&
      `${commits.length} commit${commits.length === 1 ? "" : "s"} no remote branch has (${list(commits)}); push ${commits.length === 1 ? "it" : "them"}`,
  ].filter((reason) => typeof reason === "string")
  if (reasons.length === 0) return
  return `${directory} has ${reasons.join(", and ")}. Remove it with force to discard them.`
}
