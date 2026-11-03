# Heishi

Persistent, interactive subagents for [Pi](https://github.com/earendil-works/pi-mono), running in tmux, cmux, or a headless background process.

Heishi lets Pi delegate work to concurrent agent sessions, steer them while they run, and resume completed sessions without losing context.

## Requirements

- [Pi](https://github.com/earendil-works/pi-mono)
- Optional: [tmux](https://github.com/tmux/tmux) or [cmux](https://cmux.com) to watch and focus workers in a terminal
- At least one authenticated Pi model

## Install

```sh
pi install git:github.com/Wayaans/heishi
```

Restart Pi, then open Heishi settings:

```text
/heishi
```

Choose Global or Current project first, then configure the default mode, main-mode workspace, terminal host, and worktree cleanup approval. Trusted project settings override individual global values. Settings without a project override inherit their global value. `/heishi settings` opens the same interface.

## Usage

Heishi gives Pi two tools:

- `subagent_start` starts a worker in the configured terminal host
- `subagent_control` prompts, steers, or aborts a worker. Prompting a settled worker resumes it automatically.

Workers run asynchronously, so the main agent never blocks on them. When a worker settles (completed, blocked, failed, or cancelled), Heishi sends its result to the main agent as a completion message containing the report and run duration. The message appears as a box with the status, duration, model, worktree, and worker location. Expand it (Ctrl+O) to see the full report. If the main agent is busy, the message is steered into its current run. If it is idle, the message starts a new turn. A result that has not reached the parent when its session ends, such as a worker cancelled by quitting Pi, is added to the session context the next time that session starts, without starting a turn. In print mode (`pi -p`), the parent can exit before its workers finish, and those results are lost.

Workers have two modes:

- `sub` (default) uses Heishi's fast, constrained resource profile.
- `main` loads normal Pi resources, including extensions, skills, prompt templates, themes, context files, settings, and packages. It can delegate recursively.

Workers start with Pi's default model and thinking level. The agent passes `model` or `thinking` only when you explicitly ask for them. Heishi rejects a requested model that is unknown, unauthenticated, or does not support the requested thinking level.

Choose a mode by the task's intended repository side effects, not by keywords:

| Task | Mode |
| --- | --- |
| Read-only exploration, research, analysis, audit, review, or a report returned to the parent | `sub` |
| Implementation, fixes, refactoring, or creating, editing, deleting, formatting, or generating repository files | `main` |

Tell read-only workers not to modify files and to return findings in their final report. For mixed investigation and write work, prefer a sub-mode investigation followed by a main-mode implementation; if the work cannot be split, use `main`. Returning a report through a completion message is read-only, while saving that report in the repository is write work.

The main agent passes `mode` explicitly after classifying a task. Configure the fallback globally or for a trusted project through `/heishi`. An explicit `subagent_start.mode` overrides the effective configured value for one run. The built-in default is `sub` when neither scope sets a value.

When a model or thinking level is requested, Heishi verifies that Pi started with it before submitting the task. If Pi substitutes a model or clamps thinking, the start fails. Results show the model and thinking level the worker actually started with. Resuming a main worker restores its saved session model and thinking level.

Main workers mirror the parent session's project trust. They load trusted extensions with normal process permissions and model credentials; they are not sandboxes.

Use `/subagent` to manage workers in the interactive overlay: focus or resume, steer, follow up, abort, clean up a worktree, or view details. Both modes prefer structured reports and fall back to the worker's final assistant response.

### Worktree workspaces

Workers use the shared checkout by default. Main-mode workers can instead use an isolated Git worktree by passing `workspace: "worktree"`. Configure the main-mode workspace globally or for a trusted project through `/heishi`. An explicit `subagent_start.workspace` overrides the effective configured value in main mode. Sub mode always uses the shared checkout and rejects an explicit worktree.

Heishi requires the source checkout to be clean, including untracked files. It creates branch `heishi/<run-id>` from the source checkout's exact HEAD and places the worktree at `<agent-dir>/heishi/worktrees/<repo-name>-<repo-id>/<run-id>`. Ignored files are not copied. The worktree and branch remain after the worker settles, shuts down, or fails after launch. If startup fails before launch, Heishi removes a safely identified worktree registration and path when possible, but retains the generated branch and internal lease for manual recovery. Persisted worktree metadata records whether the worktree is present or removed, and the startup error warns that both refs were retained. Heishi never merges branches or deletes refs.

After reviewing or integrating the work yourself, select the run in `/subagent` and press `C` to clean up its worktree. The agent cannot clean up worktrees. The default `ask` approval policy displays a confirmation naming the run and exact worktree path. The `allow` policy cleans without a prompt. Configure this policy globally or for a trusted project through `/heishi`. Both policies use ordinary `git worktree remove` only when a settled worktree contains no modified, untracked, or ignored files. Cleanup also requires a verified closed terminal target and retains the branch and internal lease. Resume recreates an explicitly removed worktree from that retained branch at the same path. Heishi refuses missing or inconsistent workspace state instead of pruning or overwriting it. No Heishi tool deletes refs.

### Terminal hosts

Set `terminalHost` to `auto`, `tmux`, `cmux`, or `headless` through `/heishi`. The built-in default is `auto`. Explicit values validate only the selected host. Auto mode checks the current tmux and cmux caller contexts for each start and resume. If both hosts are valid, Heishi compares the controlling terminal with the tmux pane. It refuses an ambiguous result and asks you to select a host instead of launching into the wrong terminal. If neither is available, auto mode falls back to `headless`.

The `headless` host runs each worker as a background `pi --mode rpc` child process. Workers keep the same steering, reports, resume, and cleanup behavior, but have no terminal to focus: `/subagent` shows details instead. Extension dialogs inside a headless worker are cancelled automatically because nobody can answer them. Headless workers shut down when the parent Pi process exits, after finishing any active turn. Heishi records each worker's PID and start time, so a restored session verifies the exact process is gone, or stops it, before allowing resume or cleanup.

Active workers keep their recorded host even if the setting changes. A settled worker may resume in another host after its previous target is verified closed. Heishi stores stable cmux UUIDs and the cmux socket path, not topology-dependent short references.

Placement is not configurable. Each mode uses a fixed placement, which maps to each host differently:

| Placement | tmux | cmux |
| --- | --- | --- |
| `window` | Detached window in the current session | Surface tab in the caller pane |
| `session` | Detached window in `heishi-subagents` | Surface tab in the caller pane |

Sub workers use `session` and main workers use `window`. Cmux maps both placements to surface tabs in the caller pane and launches them without focus changes. Heishi names each worker tab with its mode, alias, and short run ID, for example `sub · Circe · a1b2c3`. Heishi also disables cmux's Pi lifecycle hooks inside managed workers so Heishi remains responsible for stop, resume, and cleanup.

Shared-workspace subagents use the current checkout. Run concurrent shared writers only on separate files; use main-mode worktree workspaces for isolated checkouts.

### Delegation contract

Every worker runs in a fresh session without the parent conversation, prior tool results, assumptions, or decisions. A `subagent_start.task` must therefore be a self-contained brief with the objective, relevant background, scope, constraints, expected deliverable, and verification. Heishi marks messages as delegations from the parent and instructs workers to return all communication to that parent rather than addressing the user.

When a worker needs human or other external input, it reports `status: "blocked"` with a structured `request` containing the request kind, exact prompt, and optional detail, choices, and recommendation. The completion message carries that request to the parent. The parent can obtain the answer and send it with `subagent_control` action `prompt`, which resumes the worker. A new completion message arrives when the worker settles again.

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
