import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkout } from "../src/git.js"

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
