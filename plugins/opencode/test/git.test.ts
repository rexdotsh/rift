import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkout, unsaved } from "../src/git.js"

const directories: string[] = []
const context = { signal: new AbortController().signal }

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "rift-git-"))
  directories.push(directory)
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
      encoding: "utf8",
    }).trim()
  git("init", "-q", "-b", "main")
  writeFileSync(path.join(directory, "file.txt"), "main\n")
  git("add", ".")
  git("commit", "-q", "-m", "main")
  git("switch", "-q", "-c", "feature")
  writeFileSync(path.join(directory, "file.txt"), "feature\n")
  git("commit", "-q", "-am", "feature")
  git("switch", "-q", "main")
  return { directory, git }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("starting ref checkout", () => {
  test("detaches HEAD at the requested ref", async () => {
    const { directory, git } = repository()
    await checkout(directory, "feature", context.signal)
    expect(git("rev-parse", "HEAD")).toBe(git("rev-parse", "feature"))
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
  })

  test("reports git's error for an unknown ref", async () => {
    const { directory } = repository()
    await expect(checkout(directory, "missing", context.signal)).rejects.toThrow("missing")
  })

  test("refuses to overwrite conflicting uncommitted changes", async () => {
    const { directory } = repository()
    writeFileSync(path.join(directory, "file.txt"), "dirty\n")
    await expect(checkout(directory, "feature", context.signal)).rejects.toThrow("would be overwritten")
  })
})

describe("unsaved work check", () => {
  // A pushed source checkout, copied the way Rift copies it: the whole directory, `.git` included.
  function workspaces(options: { submodule?: boolean } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "rift-unsaved-"))
    directories.push(root)
    const run = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    const source = path.join(root, "source")
    run(root, "init", "-q", "--bare", "-b", "main", "origin.git")
    run(root, "clone", "-q", path.join(root, "origin.git"), "source")
    writeFileSync(path.join(source, ".gitignore"), "ignored/\n")
    writeFileSync(path.join(source, "file.txt"), "main\n")
    run(source, "add", ".")
    run(source, "commit", "-q", "-m", "main")
    run(source, "push", "-q", "origin", "main")
    if (options.submodule) {
      run(root, "init", "-q", "--bare", "-b", "main", "lib.git")
      run(root, "clone", "-q", path.join(root, "lib.git"), "lib-seed")
      writeFileSync(path.join(root, "lib-seed", "lib.txt"), "lib\n")
      run(path.join(root, "lib-seed"), "add", ".")
      run(path.join(root, "lib-seed"), "commit", "-q", "-m", "lib")
      run(path.join(root, "lib-seed"), "push", "-q", "origin", "main")
      run(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", path.join(root, "lib.git"), "lib")
      run(source, "commit", "-q", "-m", "add lib")
      run(source, "push", "-q", "origin", "main")
    }
    const copy = (name: string) => {
      const directory = path.join(root, name)
      cpSync(source, directory, { recursive: true })
      run(directory, "switch", "-q", "--detach")
      return directory
    }
    const commit = (directory: string, message: string) => {
      writeFileSync(path.join(directory, `${message}.txt`), `${message}\n`)
      run(directory, "add", ".")
      run(directory, "commit", "-q", "-m", message)
    }
    return { root, source, copy, commit, run }
  }

  const check = (directory: string, parent?: string) => unsaved(directory, async () => parent, context.signal)

  test("finds what only the workspace has", async () => {
    const { root, source, copy, commit, run } = workspaces()
    const cases: Array<[string, () => string, RegExp | undefined]> = [
      ["fresh copy", () => copy("fresh"), undefined],
      [
        "ignored files only",
        () => {
          const directory = copy("ignored")
          mkdirSync(path.join(directory, "ignored"))
          writeFileSync(path.join(directory, "ignored", "build.log"), "x\n")
          return directory
        },
        undefined,
      ],
      [
        "untracked file",
        () => {
          const directory = copy("untracked")
          writeFileSync(path.join(directory, "new.txt"), "x\n")
          return directory
        },
        /has uncommitted changes \(new\.txt\); commit or discard them\./,
      ],
      [
        "modified file",
        () => {
          const directory = copy("modified")
          writeFileSync(path.join(directory, "file.txt"), "changed\n")
          return directory
        },
        /uncommitted changes \(file\.txt\)/,
      ],
      [
        "unpushed commit",
        () => {
          const directory = copy("unpushed")
          commit(directory, "local")
          return directory
        },
        /has 1 commit no remote branch has \([0-9a-f]+ local\); push it\. Remove it with force/,
      ],
      [
        "pushed branch",
        () => {
          const directory = copy("pushed")
          run(directory, "switch", "-q", "-c", "feature")
          commit(directory, "feature")
          run(directory, "push", "-q", "origin", "feature")
          return directory
        },
        undefined,
      ],
      [
        "both",
        () => {
          const directory = copy("both")
          commit(directory, "one")
          commit(directory, "two")
          writeFileSync(path.join(directory, "new.txt"), "x\n")
          return directory
        },
        /uncommitted changes \(new\.txt\); commit or discard them, and 2 commits no remote branch has/,
      ],
      [
        "unborn repository",
        () => {
          const directory = path.join(root, "unborn")
          run(root, "init", "-q", directory)
          return directory
        },
        undefined,
      ],
      [
        "not a repository",
        () => {
          const directory = path.join(root, "plain")
          mkdirSync(directory)
          writeFileSync(path.join(directory, "notes.txt"), "x\n")
          return directory
        },
        undefined,
      ],
    ]
    for (const [name, make, expected] of cases) {
      const result = await check(make(), source)
      if (expected) expect({ name, result }).toEqual({ name, result: expect.stringMatching(expected) })
      else expect({ name, result }).toEqual({ name, result: undefined })
    }
  })

  test("commits the parent workspace still reaches are not lost", async () => {
    const { source, copy, commit } = workspaces()
    commit(source, "local")
    const directory = copy("child")
    await expect(check(directory, source)).resolves.toBeUndefined()
    await expect(check(directory, undefined)).resolves.toMatch("1 commit no remote branch has")
    commit(directory, "child")
    await expect(check(directory, source)).resolves.toMatch("2 commits no remote branch has")
  })

  test("repository and user config can't hide work", async () => {
    const { copy, commit, run } = workspaces({ submodule: true })
    const untracked = copy("untracked-hidden")
    run(untracked, "config", "status.showUntrackedFiles", "no")
    writeFileSync(path.join(untracked, "draft.txt"), "x\n")
    await expect(check(untracked)).resolves.toMatch("uncommitted changes (draft.txt)")

    // The submodule's new commit is pushed, but the superproject's gitlink change is only here.
    const gitlink = copy("gitlink-ignored")
    run(gitlink, "config", "submodule.lib.ignore", "all")
    commit(path.join(gitlink, "lib"), "pushed")
    run(path.join(gitlink, "lib"), "push", "-q", "origin", "HEAD:main")
    await expect(check(gitlink)).resolves.toMatch("uncommitted changes (lib)")
  })
})
