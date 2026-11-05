# Kimi prompt 生命周期保护设计

日期：2026-11-05。范围：MCP 桥 P1；P0 由使用方写入业务项目 Agent 规则。

## 问题和依据

session idle 与指定 prompt 结束不是同一事件。当前 turn 被 abort 后，queued prompts 仍可能继续执行。依据：[官方 Server API](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/server-api.md#prompts)。能力判断使用实际 endpoint，不依据版本字符串。

## 契约

1. 所有已有 session 的提交入口默认检查 active/queued prompts 及 runtime；忙碌则结构化返回 `SESSION_BUSY`，只有显式 `allowQueue` 才放行。
2. `kimi_wait_for_prompt` 观察 promptId，返回 settled/blocked/timeout 及 sessionStatus/queueEvidence。离队不等于实现成功。
3. `kimi_delegate_and_wait` 优先等待该 prompt，再确认 session runtime 与队列；仅 idle 才生成审查包。去重复用 idle session 同样检查队列。
4. `kimi_abort` 明确只请求取消 active turn，保留兼容字段并增加请求/确认字段。
5. `kimi_abort_and_wait` 优先按 active prompt ID 中止，队列空且 runtime 非运行/待交互才确认。queued/unknown prompt 不回退为误伤其他 turn 的 session abort。
6. 仅缺少 GET prompts（HTTP 404/405，或验证 session 存在后的旧版通用 40401）降级，旧服务不能确认完整停止。明确 promptId 的中止在旧服务上拒绝。

## 保留和限制

保留此前主检出的 Windows 启动参数、隐藏子进程、cwd/git 兼容与 metadata 截断修复。隔离副本集成，不改写主检出未提交内容。提交检查不能提供跨客户端原子锁；终止确认只针对可观察的 session 与 prompt 队列，不扩展成 OS 进程树保证。不提供 queued prompt 清理，也不自动发布。

## 验收

使用真实 client + fake HTTP 边界验证瞬时 idle、排队、busy 门禁、交互阻塞、旧服务、定向 abort 错误。补充已有客户端和工具测试，执行完整 suite、typecheck、build、便携 bundle MCP 工具发现及实际 Kimi 无文件改动 smoke。独立记录平台基线失败与实测范围。
