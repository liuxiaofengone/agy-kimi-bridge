---
name: kimi-delegate
description: Use when Antigravity should coordinate a software task (plan, review, and verify) while delegating implementation execution to Kimi Code via the kimi-delegate MCP server.
---

# Kimi Delegate

Use this skill when the user wants Antigravity to act as planner, reviewer, and coordinator while Kimi Code performs implementation.

## Rules

- Antigravity owns spec, plan, review, verification, and final completion decisions.
- Kimi owns implementation execution.
- Do not implement code directly in Antigravity, and do not substitute Antigravity native subagents (`invoke_subagent`) or `swarm` when the user has asked for Kimi execution.
- Note on Antigravity MCP tool loading: all Kimi MCP tools (`kimi_bridge_status`, `kimi_list_models`, `kimi_recent_sessions`, `kimi_find_recent_session`, `kimi_delegate_and_wait`, `kimi_wait_for_prompt`, `kimi_wait_until_idle`, `kimi_continue_task`, `kimi_review_package`, `kimi_abort_and_wait`, `kimi_delegate_task`, `kimi_get_handoff`, `kimi_get_diff`, `kimi_abort`) are lazy-loaded and invoked via `call_mcp_tool` after reading their schema (`mcp_config.json` intentionally omits `"eager": true` so Antigravity does not drop tools from the enabled set).
- Prefer `kimi_delegate_and_wait` to submit and wait for an implementation task. Keep its `sessionId` and `promptId` for follow-up observation.
- Use `kimi_get_handoff` / `kimi_review_package` and `kimi_get_diff` before reviewing Kimi's work.
- Use `kimi_continue_task` for review feedback until acceptance criteria pass.
- Enable `swarmMode` only when the task has independent work items.
- Do not auto-approve destructive commands.

## Prompt lifecycle

- A session can have an active prompt and queued prompts. Its transient `idle` status does not prove a particular task finished.
- Existing-session submission in all delegate/continue tools refuses busy sessions by default with `SESSION_BUSY`. Wait for the current task; use `allowQueue: true` only when you intentionally want a separate queued task. It never replaces or stops the current task.
- After an interrupted/timeout call, recover the existing session before creating another. When a `promptId` is known, use `kimi_wait_for_prompt`; otherwise use `kimi_wait_until_idle` and recent-session tools. A timeout leaves Kimi running.
- `kimi_wait_for_prompt.status: settled` means the prompt left the queue. Check `sessionStatus`, `queueEvidence`, and the real handoff/diff before acceptance. `blocked` needs approval/question handling, not another continuation prompt.
- `kimi_abort` cancels only the current main-agent turn. `aborted: true` and `abortRequested: true` do not prove the session stopped, and do not clear queued work.
- Before transferring workspace ownership, use `kimi_abort_and_wait` and require `terminationConfirmed: true`. If false, inspect `activePromptId`, `queuedPromptIds`, `finalStatus`, and `queueEvidence`; do not start a second writer or repeatedly abort new turns.
- Specifying a queued prompt cannot cancel it through the supported Kimi API. `QUEUED_PROMPT_NOT_CANCELLABLE` leaves the other active turn untouched.
- Older servers without the prompt queue API return `queueEvidence: unavailable`. Abort-and-wait cannot confirm complete termination in this fallback. A supplied prompt ID is never replaced by an unverified session-wide abort.
- Pre-submit checks are not an atomic lock against other Kimi clients. Keep one orchestrator per session and follow the consuming project's delegation rules.

## Startup and discovery

- The plugin defaults to `KIMI_SERVER_URL=auto`: modern Kimi binds an OS-assigned loopback port. Use returned `serverUrl`, `webBaseUrl`, and `webUrl`; do not assume port 58627.
- `kimi_bridge_status` is read-only. On first use, call `kimi_recent_sessions` to trigger preflight/startup before delegating implementation.
- A structured preflight failure with `submissionState: not_submitted` means this call submitted no session/prompt. If `startupMayStillBeRunning` is true, resolve that startup state before retrying. Distinguish startup timeout from a task-wait timeout, which leaves the original task running.
- Startup diagnostics expose safe codes only. Never request, copy, or publish raw startup output: it may contain bearer tokens or authenticated URLs.

## Delegation Prompt

Every task sent to Kimi must include:

- task
- acceptance criteria
- Antigravity plan
- swarm split suggestion when useful
- handoff requirements: a concrete final report plus committed and working-tree change evidence

## Review Loop

1. Prepare or update the spec and implementation plan.
2. Delegate to Kimi.
3. Wait for Kimi to finish or block.
4. Gather handoff and diff (`reviewPackage` / `kimi_get_handoff` / `kimi_get_diff`).
5. Inspect both `committedChanges` and `workingTreeChanges` in the handoff or review package.
   - A clean working tree does not prove Kimi made no changes; check `committedChanges` for commits and diffs.
   - `workingTreeChanges` may include pre-existing user work listed in `initialDirtyPaths`.
   - `committedChanges.available: false` means evidence is unavailable, not empty; use `unavailableReason` and direct `git log`/`git diff` when needed.
   - The bridge persists Git baselines in a local store first, then falls back to session metadata. Check `reviewWorkspace` to see which worktree supplied the committed evidence.
   - If `reviewWorkspace` differs from the session `cwd`, `workingTreeChanges` is marked `review_workspace_mismatch` instead of showing the wrong working tree.
   - `ambiguous_worktrees` means multiple worktrees advanced from the baseline; inspect `committedDiagnostics` and review Git directly.
6. Review against acceptance criteria.
7. Send precise follow-up feedback to Kimi if review fails.
8. Independently verify before declaring completion.
