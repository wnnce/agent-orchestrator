---
name: orchestrator-review
description: Review a change to Agent Orchestrator against the project's engineering standards (design and placement, complexity, readability, API, async, dependencies, errors, logging, tests), with a P1–P3 prioritized report and a verdict of 通过, 建议修改, or 需要人工审查. Use when asked to review a diff, branch, commit, or pull request in this repository, or to self-review before handing off or committing.
---

# Reviewing Agent Orchestrator changes

A review answers one question: **can this change be merged as it is, and if not, what exactly has
to change?** It checks the change against the standards in
[references/standards.md](references/standards.md) and reports only problems that have a concrete
cost. A review is read-only: do not edit, stage, or commit unless the user asks for fixes.

## 1. Understand the change

- Identify what is under review: uncommitted work (`git diff HEAD` plus untracked files), a branch
  (`git diff main...HEAD`), a commit (`git show <sha>`), or a PR.
- Read the intent: the request, commit messages, linked issue, and the design document under
  `docs/designs/` if the change implements one.
- Read the changed code in context: the callers of what changed, the code it now calls, and the
  tests next to it. Read `AGENTS.md` for the module map.

## 2. Run focused checks

Run the cheap project-wide checks and the tests related to the change. Do not run the full test
suite or production builds; that is the author's and CI's job.

```bash
bun run typecheck && bun run lint && bun run formatCheck     # seconds, whole project
.agents/skills/orchestrator-review/scripts/related-tests.sh <range> | xargs -r bun test
```

- `related-tests.sh` takes the same range `git diff --name-only` does (`main...HEAD`, `<sha>^!`) and
  defaults to uncommitted changes. It lists tests that changed or import a changed module. Add any
  test you know the change affects that imports do not reveal. If it prints nothing, `xargs -r`
  runs nothing (a bare `bun test` would run the full suite); treat that as a signal to check test
  coverage in step 3.
- The list covers web tests too. When `web/` changed, also type-check it:
  `(cd web && bunx tsc --noEmit -p .)`.
- A failing check is a P1. A check you could not run is reported as not run.

## 3. Review against the standards

Go through each dimension in [references/standards.md](references/standards.md) that the change
touches:

1. Behavior and intent
2. Design and placement
3. Complexity
4. Readability
5. API conventions (HTTP and TypeScript)
6. Async and lifecycle
7. Dependencies
8. Errors
9. Logging and tracing
10. Tests (with the `orchestrator-testing` skill)
11. Persistence, security, and hygiene

Confirm each suspected problem by reading the code path, and where cheap, by a targeted test or a
small script. If you cannot substantiate it, drop it; if it would be a P1, raise it under
`需要人工判断` instead (step 6).

## 4. Calibrate

Reviews that flag everything are ignored. Before reporting, filter:

- **Only the change.** Comment on lines the change adds or modifies, and on existing code the
  change makes wrong. Problems in untouched code are not findings; mention a serious one in one
  line under "Outside this change" at most.
- **Standards are guides, not tripwires.** Thresholds (function length, parameter count, file
  size) tell you where to look. Report a deviation only when you can name its concrete cost: a
  bug, a test that cannot be written, a rule that will be duplicated, code a reader will
  misunderstand.
- **Fit the project.** This is a personal project that values simple code. Do not ask for
  hardening against extreme edge cases, abstractions for hypothetical futures, or compatibility
  layers for removed behavior.
- **Match the existing style when it is not wrong.** Consistency with the surrounding code beats
  a personal preference.

## 5. Prioritize

Every finding gets one priority. Decide by the consequence of merging the change as it is, not by
which standard it touches.

| Priority | Merging it as it is would...              | Typical cases                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1**   | break something or cause damage           | Wrong behavior in a realistic case; data loss or corruption; a secret in logs or responses; an injection or path traversal; a failing typecheck, lint, or related test; a breaking change to an API, SDK, or tool that callers have not been migrated to; a floating promise or unstopped timer that can crash, hang, or leak                                                            |
| **P2**   | leave a real cost that will be paid later | Logic in the wrong module or a new reverse dependency; a changed behavior without a test, or a fix without a regression test; an async hazard not yet triggered (check-then-act across `await`, unbounded wait); a function that mixes responsibilities you can name; a new endpoint that breaks the API conventions; swallowed errors, silent fallbacks, wrong log levels on a hot path |
| **P3**   | be fine, but it could be better           | Naming, comments, small simplifications, local readability. Report at most five; drop the rest                                                                                                                                                                                                                                                                                           |

When unsure between two priorities, pick the lower one.

## 6. Decide the verdict

The verdict is exactly one of three values. Check them in this order:

1. **需要人工审查**: the decision is not yours to make, whatever the findings are. This applies
   when:
   - the intent is unclear, or the change contradicts the request or its design document;
   - the change makes a decision the owner should take: a new architectural direction, a breaking
     change to a public API, project SDK, or agent tool name, a schema change that alters or drops
     existing data, a change to authentication, authorization, or secret handling;
   - you suspect a P1 but cannot confirm or rule it out;
   - correctness depends on something you could not check: a required check could not run, or the
     change's main risk is behavior that only a live runtime or chat platform can show (for
     example a new vendor protocol message) and the tests cannot stand in for it.
2. **建议修改**: at least one P1 or P2, and each has a clear fix.
3. **通过**: no P1 or P2. P3 suggestions may still be listed.

## 7. Report

Keep the report short: someone should take it in at a glance. Use the template below, with the
headings and verdict values exactly as written so pipelines and people can scan them. Omit a
section that would be empty, except `检查`. No praise, no restating the diff.

```markdown
## 结论：<通过 | 建议修改 | 需要人工审查>

<One sentence: the main reason for the verdict.>

## 问题

- **P1-1** 会话关闭：不等正在运行的 turn 结束，重启后会话一直停在 closing
- **P2-1** 创建会话接口：重试逻辑写在 HTTP 路由里，webhook 入口不会执行
- **P3-1** 会话归档：布尔参数 `force` 切换两种行为，调用处看不出含义

## 需要人工判断

- <What has to be decided and why the reviewer cannot decide it, in one line.>

## 修改建议

<Two to four sentences: what to change and in what order, referring to findings by ID.>

## 检查

`typecheck` 通过 · `lint` 通过 · `formatCheck` 通过 · 相关测试 3 个文件 45 通过 · 未运行：无

## 本次改动之外

- <At most one serious problem in untouched code, one line.>
```

- **One line per problem**: ID, the feature or flow it affects (会话关闭, 定时 job 轮询, 创建会话接口),
  then what is wrong with its consequence in a single clause. No file paths or line numbers, no
  fix in the line, no separate fields. Name a function or file only when the feature name alone
  would be ambiguous. Order by priority and number within each priority (`P1-1`, `P1-2`,
  `P2-1`, ...) so follow-ups can refer to them.
- **One recommendation for the whole change** under `修改建议`: the fixes that matter, grouped and
  ordered, not a repeat of every line. State that P3 items are optional. Omit it for `通过`
  without findings.
- `需要人工判断` appears only with the verdict `需要人工审查`.
- If there are no findings, the report is the verdict line, its reason, and `检查`.
