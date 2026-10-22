# Rift for OpenCode

Use Rift workspaces as the worktree backend in OpenCode V2.

```sh
npm install -g rift-snapshot@0.0.13
rift init
opencode plugin add 'github:anomalyco/rift#v0.0.13::path:plugins/opencode'
```

OpenCode's workspace UI then creates Rift workspaces, and agents get `rift.create`, `rift.list`, and `rift.remove`.
Move sessions with OpenCode's `opencode.session_move` tool.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:anomalyco/rift#v0.0.13::path:plugins/opencode",
      "options": { "copyAll": false, "hooks": true, "executable": "rift", "database": "/path/to/rift.sqlite" }
    }
  ]
}
```

- `copyAll`: exact snapshots instead of filtered ones.
- `hooks`: run `.rift.toml` lifecycle hooks. Hook output is not streamed; failures include its last 8 KiB.
- `executable`: Rift binary to run.
- `database`: non-default Rift registry.

## Limits

- A starting ref snapshots the source, then runs `git switch --detach <ref>` in the new workspace. Uncommitted
  source changes carry over when they don't conflict; on a conflict or unknown ref the workspace is removed and
  creation fails. Postcreate hooks run before the switch.
- Removing without `force` refuses, as `git worktree remove` does, when the workspace has uncommitted changes
  (tracked or untracked; ignored files don't count) or commits on `HEAD` that no remote-tracking branch has and the
  workspace it was copied from can't reach either. A Rift's commits live only in its own `.git`, unlike a Git
  worktree's. The error lists the files and commits and sets `forceRequired`. With `force`, removal goes ahead and
  discards them. A workspace without its own `.git` isn't checked.
- Remove a workspace's child Rifts before removing it.
- `rift.remove` refuses to remove the workspace the current session is in. Pass `force: true` to discard unsaved
  work.
- Windows can't create workspaces, because Rift needs copy-on-write cloning.
