# 自动端口发现与启动故障恢复

日期：2026-11-05。适用于本分支的现代 Kimi 自动启动模式，实际验证版本为 Kimi 2.5.0。

## 根因和本次行为

原配置固定使用 58627。本机该端口被其他进程绑定/用于出站连接，Kimi 启动时报 `EACCES`；“没有 LISTEN”不代表可绑定。旧桥在 spawn 后一个事件循环就停止处理后续退出错误，又忽略了启动输出，使用户只能看到 30 秒健康检查超时。

新版插件默认 `KIMI_SERVER_URL=auto`、`KIMI_SERVER_ARGS=["web","--no-open"]`。桥补充 `--port 0 --host 127.0.0.1`，由 Kimi 在绑定时请求系统分配端口，再从输出中只提取本机地址，健康检查和鉴权通过后保存发现结果。端口不用人工探测后再抢占，也不依赖某个“通常空闲”的固定端口。

发现文件与启动锁保存在 `KIMI_BRIDGE_STATE_DIR`（默认 `~/.codex-kimi-bridge/state`）下，按 Kimi 数据目录区分。文件不保存 token 或启动日志。MCP 重启后复用已发现的服务；地址失效时重新启动。自动模式的 Git 基线按数据目录标识保存，端口变化不丢失交接证据。原显式 URL 模式的基线文件仍保持原来的服务 URL 分区。

启动观察持续到就绪：早退返回 `KIMI_STARTUP_FAILED`，包含退出码、安全错误码和 `submissionState: "not_submitted"`。只扫描有界窗口，返回允许列表中的错误码，不返回或记录原始 stdout/stderr。启动超时返回 `KIMI_STARTUP_TIMEOUT` 并清理本次创建的启动子进程；若未确认清理则明确标记 `startupMayStillBeRunning: true`。

需要手工管理服务时可继续配置明确 URL。使用 `web` 时省略 `--port`，由 URL 派生；显式端口不一致会在启动前拒绝。旧版 `server run` 需使用明确 URL 和旧版启动参数，不能使用自动发现模式。

## 验证证据

- 先用真实子进程复现延迟退出：旧代码只返回通用超时，新代码快速返回结构化退出错误，注入 stdout/stderr 的测试秘密均不出现在工具结果中，未提交任务。
- 原冲突端口的实际 Kimi/MCP 测试：约 4.3 秒返回 `KIMI_STARTUP_FAILED`、`EACCES`、`not_submitted`、`startupMayStillBeRunning: false`。
- 自动模式的早期验证分配到 `http://127.0.0.1:58624`，最终安装缓存验证分配到 `http://127.0.0.1:50916`，health/auth 均通过。这些数字只是运行结果，不是配置建议。
- 实际委派 `KIMI_AUTO_PORT_OK`：对应 prompt settled、session idle，返回预期标记且临时 Git 工作区无改动。未恢复其他项目中暂停的开发任务。
- 第二个全新 MCP 进程复用同一地址并通过鉴权，验证不是只在单次启动进程中可用。
- 14 项启动/发现回归通过：含真实子进程非零/零码早退、动态地址发现、重启复用、并发启动、地址失效重建、认证失败、分片输出、超时清理、延迟诊断读取、崩溃遗留空/损坏锁和多个恢复等待者互斥。
- 独立审查发现的诊断覆盖新地址、损坏锁无法恢复、多个恢复等待者误删活锁问题均已修正并补回归；复核未发现剩余 Critical / Important。bundle 已重新构建，包含 endpointGeneration 保护。
- `pnpm typecheck`、`pnpm build` 通过。完整测试 313/323 通过，剩余 10 项仍为此前同环境的 Windows/外部脚本基线失败，清单见 [生命周期验证记录](kimi-lifecycle-verification-2026-11-05.md)。该 10 项已在同日第二轮跨平台基线加固中逐项修复，全量 340/340 通过，记录见该文档第二轮章节。
- 启动修复时安装开发版 `0.3.0+codex.20261105215100`；后续跨平台修复已升级为 `0.3.0+codex.20261105225600`，并完成双平台 376/376 和实际缓存调用验收，见 [最终验收记录](cross-platform-hardening-acceptance-2026-11-05.zh-CN.md)。需要新开 Codex 对话加载新版配置，旧 MCP 进程的结果不能代替新缓存验收。

仓库提供 `node scripts/smoke-startup.mjs`：通过真实 MCP 委派一次只回复标记、不修改文件的 smoke；`status-only` 模式仅检查新 MCP 进程能否复用发现结果。

## 可加入业务项目 AGENTS.md 的规则

以下内容面向消费桥接服务的项目，可直接采用：

```markdown
### Kimi 委派启动与恢复

- 使用新版 kimi-delegate 自动发现模式；不要在项目规则、脚本或检查中硬编码 58627，使用 kimi_bridge_status 返回的 serverUrl / webBaseUrl 和任务返回的 webUrl。
- kimi_bridge_status 是只读检查。首次 server_unreachable 后，先调用 kimi_recent_sessions 触发预检查和自动启动；服务与鉴权通过后再委派开发。启动失败应报告诊断并暂停开发委派。
- preflight 错误只有明确返回 submissionState: not_submitted 时，才能判断本次未创建/提交任务；若 startupMayStillBeRunning 为 true，先核查启动进程状态，再决定重试。
- 已取得 sessionId / promptId 后的中断或等待超时按原任务恢复，使用 kimi_wait_for_prompt / kimi_wait_until_idle 观察；不要通过再次提交任务或 kimi_continue_task 查询进度。
- Kimi 正在运行或存在排队 prompt 时，保持 SESSION_BUSY 默认保护。停止并移交写入前，必须核对 kimi_abort_and_wait 的 terminationConfirmed、activePromptId、queuedPromptIds 和 queueEvidence。
- 只使用脱敏后的工具诊断；不要粘贴 Kimi 原始启动日志、bearer token 或带 token 的 URL。不得以关闭鉴权、切换所有网卡监听或终止其他服务来绕过启动错误。
- 插件更新后打开新的 Codex 对话加载新版 MCP；验收需要实际调用和真实 diff/测试证据，不能只凭安装成功或服务 ready 宣告开发任务完成。
```

## 可加入 quickstart 的内容

以下步骤是安装/更新后的启动验收；Kimi Code 自身仍需提前安装并完成账号登录。

```markdown
### Kimi 委派桥快速检查

1. 在本地插件市场仓库的 plugins/kimi-delegate/.mcp.json 中确认：
   KIMI_SERVER_URL="auto"、KIMI_AUTO_START="true"、KIMI_SERVER_ARGS="[\"web\",\"--no-open\"]"。
   KIMI_SERVER_TOKEN 保持为空，由本机 token 文件读取；kimi 不在 PATH 时设置 KIMI_COMMAND 为实际可执行文件。
2. 安装/刷新插件后打开新的 Codex 对话。在对话中说：
   “请先调用 kimi_recent_sessions 触发 Kimi 预检查，再调用 kimi_bridge_status 核实 healthzOk 和 authOk，给我返回的实际服务地址。不要创建开发任务。”
3. 确认 status=ready、healthzOk=true、authOk=true；打开返回的 webBaseUrl，按需查看 Kimi。无需手工指定端口。
4. 正式委派使用 kimi_delegate_and_wait，保留 sessionId 和 promptId；超时后继续观察同一任务，完成后独立审查 reviewPackage、Git diff 和测试。
5. 若为 KIMI_STARTUP_FAILED / KIMI_STARTUP_TIMEOUT，记录安全错误码和 submissionState。not_submitted 表示本次未提交任务；若 startupMayStillBeRunning=true，先核查再重试。
   Windows 的端口诊断应查看全部 TCP 状态及系统排除范围，不能只查 LISTEN。优先修正启动/发现配置，不改动其他服务。
```
