# AGENTS.md

## Project

`codex-kimi-bridge` is a local Codex plugin plus MCP bridge. Its purpose is to let Codex act as planner/reviewer while Kimi Code performs implementation through the local Kimi server.

Default workspace: the repository checkout containing this file (clone it
wherever you work; nothing in the build or tests depends on an absolute path).

Related Kimi Code source checkout: a local clone of the Kimi Code source tree,
used only when a task explicitly asks to inspect it. Its location is
machine-specific and is not required for bridge development.

## Collaboration Rule

The preferred workflow is:

1. Codex writes the spec and plan.
2. Codex delegates implementation to Kimi through `kimi_delegate_and_wait`.
3. Kimi changes code and runs verification.
4. Codex reviews the embedded `reviewPackage`, independently verifies, and either accepts or sends follow-up feedback.

Do not manually implement feature work in Codex when the user says execution should happen in Kimi. Codex may still do small local maintenance tasks when explicitly asked, such as reinstalling the plugin, committing already-reviewed work, or writing this file.

Reusable prompt templates live in:

```text
docs/prompts/kimi-delegate-workflow.md
```

## Current Plugin State

Local marketplace (repo-relative):

```text
.agents/plugins/marketplace.json
```

Plugin id:

```text
kimi-delegate@codex-kimi-bridge-local
```

MCP config:

```text
plugins/kimi-delegate/.mcp.json
```

The plugin MCP server currently launches:

```text
node ./mcp/server.mjs
```

After code changes that affect MCP tools or plugin config, run:

```bash
pnpm build
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Then open a new Codex thread or restart Codex if the tool list does not refresh.

- `plugins/kimi-delegate/mcp/server.mjs` is a tracked generated artifact.
- Source changes affecting MCP runtime require `pnpm build` and committing the regenerated bundle.
- Fresh clone installation does not require pnpm because the bundle is tracked.
- For development cache refresh, finish active delegated tasks, use `codex plugin remove` then `codex plugin add`, and open a new Codex chat. A separate local `+codex.<timestamp>` manifest version is another cache refresh option. No personal-directory helper scripts are required; release manifests use plain semantic versions.

## Kimi Server

The bundled plugin uses automatic local server discovery:

```text
KIMI_SERVER_URL=auto
KIMI_SERVER_ARGS=["web","--no-open"]
```

The bridge starts modern Kimi with `--port 0 --host 127.0.0.1`, reads the OS-assigned endpoint, verifies health/auth, and persists only the endpoint under `KIMI_BRIDGE_STATE_DIR`. Do not hard-code port 58627 in consuming projects. Use `kimi_bridge_status.serverUrl` / `webBaseUrl` or a task's `webUrl`. New MCP processes reuse the discovered server. The discovery file and startup lock are scoped to the Kimi data home; auto-mode Git baselines use that identity rather than the changing port.

`kimi_bridge_status` only reads discovery state and checks live health; a first-use `server_unreachable` does not itself trigger startup. Use a read-only preflight-triggering call such as `kimi_recent_sessions` to verify automatic startup before submitting implementation.

`KIMI_STARTUP_FAILED`, `KIMI_STARTUP_TIMEOUT`, `KIMI_AUTH_FAILED`, and startup configuration/lock errors expose `submissionState: not_submitted`. No session or prompt has been submitted by that failed call. If `startupMayStillBeRunning` is true, resolve the startup process state before retrying. A timeout after task submission has different semantics: recover the original session/prompt and do not duplicate work.

The bridge supports both legacy Kimi Session `status` responses and Kimi 0.27+ `busy` / `pending_interaction` / `last_turn_reason` responses. All lifecycle decisions normalize these into one Bridge runtime status. `kimi_bridge_status` may expose safe `serverVersion` and `backend` metadata from `/api/v1/meta`, but this metadata is diagnostic only and never selects the compatibility path.

For manually managed or older Kimi versions, configure an explicit `KIMI_SERVER_URL` and use the startup commands supported by that version. A legacy example is:

```bash
kimi server install
kimi server start
```

With explicit URL and blank `KIMI_SERVER_ARGS`, legacy auto-start uses:

```bash
kimi server run --keep-alive
```

With explicit URL and `web` arguments, omit `--port` to derive it from the URL; conflicting explicit ports are rejected. Automatic discovery requires modern Kimi with port-0 support (verified on 2.5.0). See `docs/kimi-startup-recovery.zh-CN.md` for verification and paste-ready consuming-project rules.

Token resolution order:

1. `KIMI_SERVER_TOKEN`
2. `$KIMI_CODE_HOME/server.token`
3. `~/.kimi-code/server.token`

Do not commit real tokens. `.mcp.json` keeps `KIMI_SERVER_TOKEN` empty.

## Useful Kimi Delegate Tools

Use these from Codex when the plugin is loaded:

- `kimi_bridge_status`: live read-only diagnostics; does not auto-start, refresh token, or update cache.
- `kimi_recent_sessions`: list recent Kimi sessions; use this first when a previous delegate was interrupted or you suspect a duplicate/running/aborted session.
- `kimi_find_recent_session`: find a recent Kimi session by title substring; preferred when recovering from an interruption, quota recovery, or suspected duplicate task.
- `kimi_delegate_task`: start a Kimi task from a Codex spec/plan.
- `kimi_delegate_and_wait`: preferred one-call flow; delegates, waits, and returns `reviewPackage` when idle. Supports an optional `dedupe` object to avoid duplicate sessions.
- `kimi_wait_until_idle`: wait for both runtime and pending prompts to settle, or report approval/question blocking; older servers fall back to runtime status.
- `kimi_wait_for_prompt`: wait for a specific `promptId`; `settled` means it left the queue, not that the implementation succeeded. Inspect `sessionStatus` and `queueEvidence`.
- `kimi_get_handoff`: summarize Kimi output, changed files, and diffs.
- `kimi_review_package`: re-fetch a structured review package for an existing session.
- `kimi_get_diff`: inspect a specific file diff.
- `kimi_continue_task`: send review feedback or follow-up work to an existing Kimi session.
- `kimi_abort`: request cancellation of the current main-agent turn; it does not clear queued prompts or confirm session termination.
- `kimi_abort_and_wait`: abort the active prompt and observe termination. Only `terminationConfirmed: true` confirms no active/queued prompts and a settled runtime at the observed point.

### Lifecycle safety

- Existing-session submission defaults to refusing active/queued work (`SESSION_BUSY`) in all delegate/continue tools. `allowQueue: true` is an explicit choice to enqueue, not a way to replace or stop the current task.
- Prefer `kimi_delegate_and_wait` and keep its `promptId`. On timeout, observe it with `kimi_wait_for_prompt`; do not submit another task to check progress.
- `abortRequested` only records an accepted abort request. Check `terminationConfirmed`, `activePromptId`, `queuedPromptIds`, and `queueEvidence` before handing ownership to another worker.
- Queued prompts cannot be individually cancelled through the supported Kimi API. Do not repeatedly abort whichever turn becomes active to simulate queue clearing.
- Missing prompt API support is reported as `queueEvidence: unavailable`; complete termination is not confirmed in that fallback.
- P0 belongs in the consuming project's delegation rules. The bridge's P1 checks enforce a conservative default but cannot lock out other Kimi clients atomically.
- See `docs/kimi-lifecycle-guardrails.zh-CN.md` for examples and limitations.

Delegate and review tools return `webUrl`, which can be opened in Kimi Web to watch the session.

## Reviewing handoffs

`kimi_get_handoff`, `kimi_review_package`, and the embedded `reviewPackage` from `kimi_delegate_and_wait` expose both committed and working-tree evidence:

- `committedChanges`: changes already committed by Kimi from the delegation baseline to current `HEAD`.
- `workingTreeChanges`: current staged, unstaged, and untracked changes.
- `initialDirtyPaths`: paths that were already dirty when the session was created (diagnostic only).
- `reviewWorkspace`: the worktree path whose `HEAD` advanced from the baseline and supplied `committedChanges`. When Kimi committed in a nested worktree, this reveals the real location of the commits.
- Top-level `changedFiles`, `additions`, `deletions`, and `diffs` aggregate both sources for compatibility.

Baselines are persisted in a Bridge-owned local store (`~/.codex-kimi-bridge/state` by default, override with `KIMI_BRIDGE_STATE_DIR`) because real Kimi servers strip arbitrary session metadata. The store contains no tokens, uses one file per session, and survives MCP/Codex restarts.

Review rules:

- Do not infer "no changes" from a clean working tree alone. Inspect `committedChanges` for commits and file diffs.
- `workingTreeChanges` may include pre-existing user work; compare with `initialDirtyPaths`.
- `available: false` in `committedChanges` means evidence is unavailable, not that there are zero committed changes. Read `unavailableReason` and use direct `git log`/`git diff` when needed.
- If `reviewWorkspace` differs from the session `cwd`, `workingTreeChanges` is marked `available: false` with `review_workspace_mismatch` rather than falsely reporting the session root's working tree.
- `ambiguous_worktrees` means multiple worktrees advanced from the baseline; inspect `committedDiagnostics` and the candidate paths, then use direct Git review.
- Legacy sessions created before this feature lack a baseline and return `baseline_unavailable`.
- Review both change sets before acceptance and use `kimi_continue_task` for fixes.

## Handling interrupted or duplicate sessions

If a previous `kimi_delegate_and_wait` was interrupted (for example, by pressing Esc), or if you are unsure whether a task is already running, the recommended approach is to pass `dedupe` to `kimi_delegate_and_wait`:

```json
{
  "titleContains": "<a stable substring from the original task title>",
  "reuseIfStatus": ["running", "idle", "awaiting_approval", "awaiting_question"]
}
```

When recovering from an interruption or deciding whether to reuse an old session, set `includeSummary: true` on `kimi_find_recent_session` or on `kimi_delegate_and_wait.dedupe` to see the last user/assistant message and message count. Leave it `false` by default to avoid the extra message fetch.

`dedupe` only reuses sessions in `running`, `idle`, `awaiting_approval`, or `awaiting_question` status. It never automatically reuses an `aborted` or `failed` session. If the matched session is `aborted` or `failed`, inspect the `webUrl` and use `kimi_continue_task` to resume it manually; do not expect `kimi_delegate_and_wait` to resume it automatically.

By default, `dedupe` only reuses a session when its `metadata.cwd` matches the `cwd` passed to `kimi_delegate_and_wait`. This prevents accidentally reusing a session from a different project or workspace even when the title matches. Only pass `matchAnyCwd: true` when you intentionally want to recover a session from another workspace; for daily use, keep the default `cwd-safe` behavior.

If you need more control, or if the task title is hard to make unique, call `kimi_find_recent_session` (when you remember part of the title) or `kimi_recent_sessions` first. Check the returned `status`, `title`, and `webUrl` to decide whether to continue an existing session (`kimi_continue_task`), wait for it (`kimi_wait_until_idle`), or abort it (`kimi_abort`). Do not blindly start a new `kimi_delegate_task` before confirming there is no orphaned or duplicate session.

## Verification Commands

Run these before accepting implementation:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm validate:plugin
```

`pnpm validate:plugin` runs the repository-local `scripts/validate-plugin.mjs`
(Node >= 20, no Python or personal-directory dependencies). It checks the
manifest fields, plugin-relative skill/MCP/bundle paths, portable MCP packaging,
and rejects baked-in token values or machine-specific paths.

For plugin installation smoke checks:

```bash
codex plugin list | rg 'kimi-delegate|codex-kimi-bridge-local'
```

Expected status:

```text
kimi-delegate@codex-kimi-bridge-local  installed, enabled  0.3.0
```

## Completed MVP Capabilities

- Codex local plugin install works.
- MCP tools are exposed by Codex.
- Kimi server auth is handled via server token.
- Kimi server preflight and auto-start work.
- Successful preflight checks are short-cached by `KIMI_PREFLIGHT_CACHE_MS`.
- `kimi_bridge_status` reports `webBaseUrl`, `canOpenWeb`, `status`, `nextActions`, and diagnostics without leaking token values, and may include safe `serverVersion`/`backend` metadata from `/api/v1/meta`.
- `kimi_delegate_and_wait` returns an embedded `reviewPackage` on idle results.
- `kimi_review_package` can re-fetch review material for an existing session before commit.
- Delegate/continue responses include Kimi Web session URLs.
- `kimi_recent_sessions` and `kimi_find_recent_session` can recover interrupted or duplicate sessions.
- `kimi_delegate_and_wait.dedupe` prevents duplicate sessions, defaults to cwd-safe matching, and can include cleaned session summaries for recovery decisions.
- Session summaries skip internal reminder/control messages and redact token-like values.
- Handoff expands untracked directories into concrete file paths when possible.
- Bridge runtime status normalizes both legacy `status` responses and Kimi 0.27+ `busy`/`pending_interaction`/`last_turn_reason` responses.
- `failed` is an explicit terminal status: it receives no success `reviewPackage` and is not automatically reused by dedupe.
- End-to-end smoke test passed: Codex delegated a file creation to Kimi, read handoff/diff, reviewed the result, then delegated cleanup.

## Good Next Tasks

Prefer using this bridge on a real external repo/task before adding more abstractions. If optimizing further, useful candidates are:

- Improve status output if real usage reveals confusing diagnostics.
- Add more integration tests around real Kimi server API shape when safe.

## Important Boundaries

- Do not change Kimi Code server unless explicitly requested.
- Do not change Codex plugin installation mechanics unless the task is specifically about plugin packaging.
- Do not use `--dangerous-bypass-auth` as a default. It is only for local smoke testing.
- Do not leak or commit token values.
- Do not revert user or Kimi changes unless the user explicitly asks.
