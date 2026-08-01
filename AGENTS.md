<agent-rule-and-guidelines>

## Think Before Coding

Never assume intent. Never bury uncertainty. Always surface tradeoffs before writing code.

Before implementing:

- State every assumption explicitly—treat unstated assumptions as bugs waiting to happen. If anything is uncertain, stop and ask; do not guess and proceed.
- When multiple valid interpretations exist, enumerate them and let the user choose—never silently pick one and hope it was right.
- If a simpler approach would work, name it first and explain why you might or might not use it. Push back when the requested path is unnecessarily complex or risky.
- If requirements, scope, or expected behavior are unclear, halt immediately. Name exactly what is ambiguous and ask a targeted question—do not fill gaps with invention.

## Simplicity First

Write the minimum code that solves the stated problem. Zero speculative additions.

- Ship only what was asked—no bonus features, no "while I'm here" enhancements, no anticipatory hooks for future work.
- Do not abstract code used once—inline it. Abstractions must earn their existence through reuse, not hypothetical reuse.
- Do not add flexibility, configurability, or parameterization the user did not request—hardcode the known case.
- Do not handle errors for scenarios that cannot occur given the actual constraints—defensive code for impossible paths is noise.
- If the diff grows large, stop and ask whether a smaller solution exists. If you wrote 200 lines and 50 would suffice, rewrite—do not submit the bloated version.
- Before finishing, ask: "Would a senior engineer reject this as overcomplicated?" If yes, simplify or cut until the answer is no.

## Surgical Changes

Touch only what the request requires. Clean up only mess your own changes created.

When editing existing code:

- Do not "improve" adjacent lines, comments, formatting, or naming—the diff is not a refactor opportunity unless explicitly asked.
- Do not refactor working code that is unrelated to the task—leave it exactly as you found it.
- Match the file's existing style, patterns, and conventions even when you would write it differently in greenfield code.
- If you spot unrelated dead code, mention it in your response—do not delete, rename, or "clean up" it without explicit permission.

When your changes create orphans:

- Remove imports, variables, and functions that became unused solely because of your edits—your diff must not leave dangling references you introduced.
- Do not remove pre-existing dead code, unused exports, or stale comments unless the user explicitly asked for cleanup.

The test: every changed line must trace directly to the user's request. If a line cannot be justified by the task, it does not belong in the diff.

## Record Persistent Guidelines

Save guidance here only when it defines a durable development behavior that should be followed consistently across future tasks in this repository.

- Record reusable project-wide conventions, constraints, and preferences that change how development work should be performed.
- Do not record one-time instructions, task-specific requirements, implementation details, or decisions that apply only to a single feature, fix, or file.
- Before recording guidance, ask: "Would this still affect how I develop a different feature later?" If not, do not save it.
- Add each distinct guideline as its own concise bullet under `<additional-agents-guidelines>`.
- Record a reference file only when it governs recurring development behavior across multiple tasks.
- Update `AGENTS.md` in the same session when guidance meets these criteria.

</agent-rule-and-guidelines>

<additional-agents-guidelines>

- This repo use `bun` as package manager, so all commands should be run with `bun` instead of `npm` or `yarn` or else.

</additional-agents-guidelines>
