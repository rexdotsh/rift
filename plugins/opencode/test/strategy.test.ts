import { describe, expect, test } from "bun:test"
import { RpcError } from "../src/command.js"
import { makeStrategy } from "../src/strategy.js"

function fixture() {
  const calls: object[] = []
  const children = new Map<string, string[]>([
    ["/project", ["/rifts/one"]],
    ["/rifts/one", ["/rifts/two"]],
    ["/rifts/two", []],
  ])
  const call = async (_executable: string, request: object) => {
    calls.push(request)
    if (!("command" in request)) throw new Error("missing command")
    if (request.command === "create" && "into" in request && "name" in request)
      return `${request.into}/${request.name}`
    if (request.command === "descendants") return ["/rifts/two", "/rifts/one"]
    if (request.command === "list" && "of" in request && typeof request.of === "string")
      return children.get(request.of) ?? []
    return null
  }
  return { calls, children, strategy: makeStrategy({ copyAll: false }, { rpc: call }) }
}

const context = { signal: new AbortController().signal }

describe("Rift workspace strategy", () => {
  test("validates plugin options", () => {
    expect(() => makeStrategy({ executable: "" })).toThrow("non-empty")
    expect(() => makeStrategy({ copyAll: "yes" })).toThrow("boolean")
    expect(() => makeStrategy({ hooks: "yes" })).toThrow("boolean")
    expect(() => makeStrategy({ database: "" })).toThrow("non-empty")
    expect(() => makeStrategy({ unknown: true })).toThrow("Unknown Rift option")
  })

  test("creates at OpenCode's suggested destination", async () => {
    const { calls, strategy } = fixture()
    await expect(
      strategy.create({ sourceDirectory: "/project", directory: "/worktrees/task" }, context),
    ).resolves.toEqual({ directory: "/worktrees/task" })
    expect(calls).toEqual([
      {
        database: undefined,
        command: "create",
        from: "/project",
        into: "/worktrees",
        name: "task",
        copyAll: false,
        hooks: true,
      },
    ])
  })

  test("checks out a starting ref in the new snapshot", async () => {
    const { calls } = fixture()
    const checkouts: Array<[string, string]> = []
    const strategy = makeStrategy(
      { copyAll: false },
      {
        rpc: async (_executable, request) => {
          calls.push(request)
          return "/worktrees/task"
        },
        checkout: async (directory, ref) => {
          checkouts.push([directory, ref])
        },
      },
    )
    await expect(
      strategy.create({ sourceDirectory: "/project", directory: "/worktrees/task", branch: "main" }, context),
    ).resolves.toEqual({ directory: "/worktrees/task" })
    expect(checkouts).toEqual([["/worktrees/task", "main"]])
    expect(calls.map((call) => ("command" in call ? call.command : undefined))).toEqual(["create"])
  })

  test("removes the snapshot when the starting ref cannot be checked out", async () => {
    const calls: object[] = []
    const strategy = makeStrategy(
      {},
      {
        rpc: async (_executable, request) => {
          calls.push(request)
          return "command" in request && request.command === "create" ? "/worktrees/task" : null
        },
        checkout: async () => {
          throw new Error("fatal: invalid reference: nope")
        },
      },
    )
    await expect(
      strategy.create({ sourceDirectory: "/project", directory: "/worktrees/task", branch: "nope" }, context),
    ).rejects.toThrow("Rift could not start the workspace at nope: fatal: invalid reference: nope")
    expect(calls.at(-1)).toEqual({ database: undefined, command: "remove", at: "/worktrees/task", hooks: true })
  })

  test("rejects option-like refs before creating anything", async () => {
    const { calls, strategy } = fixture()
    await expect(
      strategy.create({ sourceDirectory: "/project", directory: "/worktrees/task", branch: "--orphan" }, context),
    ).rejects.toThrow("Invalid starting ref: --orphan")
    expect(calls).toEqual([])
  })

  test("discovers descendants and removes only leaves", async () => {
    const { calls, children, strategy } = fixture()
    await expect(strategy.list("/project", context)).resolves.toEqual([
      { directory: "/project", type: "root" },
      { directory: "/rifts/two", type: "worktree" },
      { directory: "/rifts/one", type: "worktree" },
    ])
    await expect(strategy.remove({ directory: "/rifts/one", force: true }, context)).rejects.toThrow(
      "Remove this Rift's child workspaces first",
    )
    children.delete("/rifts/two")
    await strategy.remove({ directory: "/rifts/two", force: false }, context)
    expect(calls.at(-1)).toEqual({
      database: undefined,
      command: "remove",
      at: "/rifts/two",
      hooks: true,
    })
  })

  test("refuses to discard unsaved work unless forced", async () => {
    const calls: object[] = []
    const inspected: Array<[string, string | undefined]> = []
    const strategy = makeStrategy(
      {},
      {
        rpc: async (_executable, request) => {
          calls.push(request)
          if ("command" in request && request.command === "list") return []
          if ("command" in request && request.command === "ancestors") return ["/project"]
          return null
        },
        unsaved: async (directory, parent) => {
          inspected.push([directory, await parent()])
          return `${directory} has uncommitted changes (file.txt); commit or discard them. Remove it with force to discard them.`
        },
      },
    )
    const refused = await strategy.remove({ directory: "/rifts/one", force: false }, context).catch((error) => error)
    expect(refused).toMatchObject({
      message: expect.stringContaining("/rifts/one has uncommitted changes (file.txt)"),
      forceRequired: true,
    })
    expect(inspected).toEqual([["/rifts/one", "/project"]])
    expect(calls.map((call) => ("command" in call ? call.command : undefined))).toEqual(["list", "ancestors"])

    calls.length = 0
    await strategy.remove({ directory: "/rifts/one", force: true }, context)
    expect(inspected).toHaveLength(1)
    expect(calls.at(-1)).toEqual({ database: undefined, command: "remove", at: "/rifts/one", hooks: true })
  })

  test("explains initialization failures", async () => {
    const failing = (code: string) =>
      makeStrategy(
        {},
        {
          rpc: async () => {
            throw new RpcError({ code, message: `${code} at /project`, path: "/project" })
          },
        },
      )
    const create = (code: string) =>
      failing(code).create({ sourceDirectory: "/project", directory: "/worktrees/task" }, context)
    await expect(create("workspace_not_initialized")).rejects.toThrow(
      "Rift source is not initialized; run `rift init` from the project root first",
    )
    await expect(create("initialization_required")).rejects.toThrow(
      "This Rift workspace must be initialized first; run `rift init` from its root folder",
    )
    await expect(create("missing_marker")).rejects.toThrow(
      "This Rift workspace is missing its `.rift` marker; run `rift init` to restore it",
    )
    await expect(create("hook_failed")).rejects.toThrow("hook_failed at /project")
  })

  test("keeps OpenCode inventory consistent after post-hook failures", async () => {
    const warnings: Array<{ directory: string; message: string }> = []
    const strategy = makeStrategy(
      {},
      {
        warning: (warning) => warnings.push(warning),
        rpc: async (_executable, request) => {
          if ("command" in request && request.command === "create")
            throw new RpcError({
              code: "hook_failed",
              message: "postcreate failed",
              path: "/worktrees/task",
              hook: "postcreate",
              committed: true,
            })
          if ("command" in request && request.command === "remove")
            throw new RpcError({
              code: "hook_failed",
              message: "postremove failed",
              path: "/rifts/.trash/task",
              hook: "postremove",
              committed: true,
            })
          return []
        },
      },
    )

    await expect(
      strategy.create({ sourceDirectory: "/project", directory: "/worktrees/task" }, context),
    ).resolves.toEqual({ directory: "/worktrees/task" })
    await strategy.remove({ directory: "/worktrees/task", force: false }, context)
    expect(warnings).toEqual([
      { directory: "/worktrees/task", message: "postcreate failed" },
      { directory: "/worktrees/task", message: "postremove failed" },
    ])
  })
})
