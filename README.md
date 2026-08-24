# Heishi

Persistent, interactive subagents for [Pi](https://github.com/earendil-works/pi-mono), running in tmux or cmux.

Heishi lets Pi delegate work to concurrent agent sessions, steer them while they run, and resume completed sessions without losing context.

## Requirements

- [Pi](https://github.com/earendil-works/pi-mono)
- [tmux](https://github.com/tmux/tmux) or [cmux](https://cmux.com)
- At least one authenticated Pi model

## Install

```sh
pi install git:github.com/Wayaans/heishi
```

Restart Pi, then open Heishi settings:

```text
/heishi
```

Choose Global or Current project first, then configure the default mode, main-mode workspace, terminal host, delegation models, and worktree cleanup approval. Trusted project settings override individual global values. Settings without a project override inherit their global value. `/heishi settings` opens the same interface.

## Usage

Heishi gives Pi three tools:

- `subagent_start` starts a worker in the configured terminal host
- `subagent_control` — prompt, steer, follow up, abort, resume, or clean up a worker workspace
- `subagent_wait` — wait for a worker to finish and return its report

Workers have two modes:

- `sub` (default) uses Heishi's fast, constrained resource profile and requires a model/thinking pair configured through `/heishi`.
- `main` loads normal Pi resources, including extensions, skills, prompt templates, themes, context files, settings, and packages. Model selection follows this priority: values explicitly requested by the user, the parent session's exact active model and thinking level, then a deliberately selected pair from the configured delegation pool as the final fallback. It can delegate recursively.

Choose a mode by the task's intended repository side effects, not by keywords:

| Task | Mode |
| --- | --- |
| Read-only exploration, research, analysis, audit, review, or a report returned to the parent | `sub` |
| Implementation, fixes, refactoring, or creating, editing, deleting, formatting, or generating repository files | `main` |

Tell read-only workers not to modify files and to return findings in their final report. For mixed investigation and write work, prefer a sub-mode investigation followed by a main-mode implementation; if the work cannot be split, use `main`. Returning a report through `subagent_wait` is read-only, while saving that report in the repository is write work.

The main agent passes `mode` explicitly after classifying a task. Configure the fallback globally or for a trusted project through `/heishi`. An explicit `subagent_start.mode` overrides the effective configured value for one run. The built-in default is `sub` when neither scope sets a value.

Main workers mirror the parent session's project trust. They load trusted extensions with normal process permissions and model credentials; they are not sandboxes.

Use `/subagent` to manage workers in the interactive overlay. Both modes prefer structured reports and fall back to the worker's final assistant response.

### Worktree workspaces

Workers use the shared checkout by default. Main-mode workers can instead use an isolated Git worktree by passing `workspace: "worktree"`. Configure the main-mode workspace globally or for a trusted project through `/heishi`. An explicit `subagent_start.workspace` overrides the effective configured value in main mode. Sub mode always uses the shared checkout and rejects an explicit worktree.

Heishi requires the source checkout to be clean, including untracked files. It creates branch `heishi/<run-id>` from the source checkout's exact HEAD and places the worktree at `<agent-dir>/heishi/worktrees/<repo-name>-<repo-id>/<run-id>`. Ignored files are not copied. The worktree and branch remain after the worker settles, waits, shuts down, or fails after launch. If startup fails before launch, Heishi removes a safely identified worktree registration and path when possible, but retains the generated branch and internal lease for manual recovery. Persisted worktree metadata records whether the worktree is present or removed, and the startup error warns that both refs were retained. Heishi never merges branches or deletes refs.

After reviewing or integrating the work yourself, use `subagent_control` action `cleanup`. The default `ask` approval policy displays a confirmation naming the run and exact worktree path. Parallel confirmations are queued and shown one at a time. The `allow` policy is standing authorization to clean without a prompt, including in non-interactive mode. Configure this policy globally or for a trusted project through `/heishi`. Both policies use ordinary `git worktree remove` only when a settled worktree contains no modified, untracked, or ignored files. Cleanup also requires a verified closed terminal target and retains the branch and internal lease. Resume recreates an explicitly removed worktree from that retained branch at the same path. Heishi refuses missing or inconsistent workspace state instead of pruning or overwriting it. No Heishi tool deletes refs.

### Terminal hosts

Set `terminalHost` to `auto`, `tmux`, or `cmux` through `/heishi`. The built-in default is `auto`. Explicit values validate only the selected host. Auto mode checks the current tmux and cmux caller contexts for each start and resume. If both hosts are valid, Heishi compares the controlling terminal with the tmux pane. It refuses an ambiguous result and asks you to select a host instead of launching into the wrong terminal.

Active workers keep their recorded host even if the setting changes. A settled worker may resume in another host after its previous target is verified closed. Heishi stores stable cmux UUIDs and the cmux socket path, not topology-dependent short references.

The public placements keep the same names but map to each host differently:

| Placement | tmux | cmux |
| --- | --- | --- |
| `pane` | Detached split pane | Split pane in the caller workspace |
| `window` | Detached window in the current session | Surface tab in the caller workspace |
| `session` | Detached window in `heishi-subagents` | Surface tab in the shared `Heishi subagents` workspace |

Sub workers default to `session`, so cmux groups them as surface tabs in one dedicated workspace. Heishi closes that workspace after its last managed surface closes. Main workers default to `window`, so cmux opens them as surface tabs in the caller workspace. Cmux workers launch without focus changes. Heishi also disables cmux's Pi lifecycle hooks inside managed workers so Heishi remains responsible for stop, resume, and cleanup.

Shared-workspace subagents use the current checkout. Run concurrent shared writers only on separate files; use main-mode worktree workspaces for isolated checkouts.

### Delegation contract

Every worker runs in a fresh session without the parent conversation, prior tool results, assumptions, or decisions. A `subagent_start.task` must therefore be a self-contained brief with the objective, relevant background, scope, constraints, expected deliverable, and verification. Heishi marks messages as delegations from the parent and instructs workers to return all communication to that parent rather than addressing the user.

When a worker needs human or other external input, it reports `status: "blocked"` with a structured `request` containing the request kind, exact prompt, and optional detail, choices, and recommendation. `subagent_wait` returns that request to the parent. The parent can obtain the answer, resume the worker, send the answer with `subagent_control`, and wait again.

## Development

```sh
git clone https://github.com/Wayaans/heishi.git
cd heishi
bun install
bun run check
bun test
```

Run opt-in adapter smoke tests from the matching host:

```sh
HEISHI_REAL_CMUX_SMOKE=1 bun test extensions/heishi/terminal-host.smoke.test.ts
HEISHI_REAL_TMUX_SMOKE=1 bun test extensions/heishi/terminal-host.smoke.test.ts
```
