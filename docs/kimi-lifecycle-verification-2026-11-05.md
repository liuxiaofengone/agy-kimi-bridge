# Kimi 生命周期保护验证记录

日期：2026-11-05。实现基线：`459d95c`。使用说明：[`kimi-lifecycle-guardrails.zh-CN.md`](kimi-lifecycle-guardrails.zh-CN.md)。

## 交付范围

- client 支持 prompt queue 查询和定向 abort。
- 所有 existing-session 提交入口默认拒绝忙碌 session；桥内并发提交的检查与提交区间有互斥保护，显式 `allowQueue` 才允许排队。
- `kimi_delegate_and_wait` 跟踪 promptId，并保留 `promptWait`；session 空闲及队列清空后才构建审查包。已观察到的 failed/aborted 不被后来的 idle 覆盖。
- `kimi_wait_for_prompt`、`kimi_abort_and_wait` 新工具，结构化门禁错误和明确的中止语义。
- 兼容缺 GET prompts 的旧服务：HTTP 404/405，或确认 session 存在后的通用 40401。真实 session 缺失、网络和认证错误继续上报。
- 保留此前主检出已有的 Windows/Kimi 2.x 自动启动、Git 兼容和 metadata 截断修复。复制到隔离副本集成，主检出的原始未提交内容未被覆盖。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| 生命周期专用回归 | 20/20 通过 |
| lifecycle/client/http/preflight/config 定向套件 | 92/92 通过 |
| 插件便携启动、release metadata、入口保护、包内路径/凭据检查 | 5/5 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build`，包含 tracked bundle | 通过 |
| `git diff --check` | 通过 |
| 原始 HEAD 全量 Vitest，同一本机环境 | 250 通过 / 15 失败 |
| 当前全量 Vitest，同一本机环境 | 299 通过 / 10 失败 |
| 失败用例名集合对比 | 当前失败全部属于基线失败，没有新增失败 |

全量通过直接调用 Vitest 的 JSON reporter 运行；该执行方式与 `pnpm test` 使用同一套件，仅保留统计和失败用例名，避免旧版 config 测试的断言值包含本机真实 token。更早的受限沙盒运行有额外 localhost 失败，不能与本机结果混用。

仍失败的 10 项：

1. `FileBaselineStore survives concurrent saves for the same session`：Windows 并发覆盖 rename 的 EPERM。
2. `NodeGitInspector selects a newly created nested worktree that advanced from baseline`。
3. `NodeGitInspector selects an existing worktree that was at baseline and then advanced`。
4. `NodeGitInspector returns ambiguous_worktrees when multiple worktrees advanced from baseline`。
   上述三项是 Windows 正反斜杠路径断言不一致。
5. `isDirectExecution returns true when the module URL matches the argv entry path and basename is index.js`。
6. `isDirectExecution compares normalized absolute paths`。
   上述两项使用 POSIX file URL 与 Windows 绝对路径比较。
7. `bridge integration persists baseline across processes when the server strips metadata`：Windows 子进程 `spawn pnpm ENOENT`。
8. `Codex plugin package passes local plugin validation`：测试写死 macOS 的 Python 校验脚本路径；本机该脚本不存在。没有将其标为通过。CLI 实际安装和便携 MCP 启动另已核验。
9. `dedupe guard in delegate_and_wait ignores trailing slash differences when matching cwd`。
10. `cwd filtering in find_recent_session ignores trailing slash differences when filtering by cwd`。
    上述两项是已有的 Windows cwd 尾分隔符规范化问题。

## 独立审查及修复

独立审查指出桥内并发检查竞态、失败终态被后续 idle 覆盖、旧服务错误形态识别不全。针对三项先增加失败用例，再修复实现；相关回归全部通过。保留的跨客户端限制已写入说明，未声称服务端原子锁或进程树终止保证。

## 真实 Kimi 2.5.0 / MCP stdio 验证

在临时 Git 仓库执行只回复标记、不使用工具、不修改文件的 smoke：

- 新 bundle 通过 MCP stdio 暴露 `kimi_wait_for_prompt` 和 `kimi_abort_and_wait`。
- active session 的默认续派返回 `SESSION_BUSY`。
- `allowQueue: true` 返回真实 `queued` prompt；按该 promptId 等到 settled，再确认 session idle。
- handoff 验证 `KIMI_QUEUED_P1_OK`。
- idle session 的 abort-and-wait 不发送无对象的中止请求；返回 `abortRequested: false` 和 `terminationConfirmed: true`。
- 对 active prompt 定向中止，返回 `abortRequested: true`、`terminationConfirmed: true`、`finalStatus: aborted` 和空队列。
- 在同一个 smoke session 验证 `kimi_delegate_and_wait`：返回对应 promptId、`promptWait: settled`、`wait: idle`、reviewPackage，并验证 `KIMI_ONECALL_P1_OK`。
- 临时仓库仅有预先放置的 sentinel 文件，内容与 Git 状态保持不变。未委派业务项目开发。

首次 smoke 脚本误读 handoff 的 `summary` 字段，在队列测试完成后退出；改用实际字段 `finalMessage` 后从同一 session 续验，未重复提交已完成任务。

## 本地安装状态

安装开发版 `0.3.0+codex.20261105155700`。这是本机开发缓存标识；正式发布仍应使用语义版本。

原 marketplace 来源是 `C:/tool/codex-kimi-bridge`。为保留其中的未提交内容，现已通过 Codex 标准 CLI 将 `codex-kimi-bridge-local` 来源切换到当前 `kimi-lifecycle-guardrails/codex-kimi-bridge` 隔离工作区。旧缓存保留，不覆盖主检出；正式合入主检出后应再将来源切回主检出，避免未来从旧源码重装。

安装后独立启动实际缓存，确认：

- manifest、MCP config、skill、bundle 与当前源码完全相同。
- bundle SHA-256：`0adcd2aba278ace45182ad9e247a76f977980fad38a7a0de4565a93f027e3686`。
- 两个新工具、三个提交入口的 `allowQueue` schema 均已暴露。
- `kimi_bridge_status` 为 ready，serverVersion 为 2.5.0。

当前已打开的 Codex 对话仍使用旧工具快照；在新对话中加载新版工具。此项区别于安装和缓存启动已通过。未推送 GitHub。
