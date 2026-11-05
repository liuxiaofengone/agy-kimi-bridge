# Kimi 委派生命周期保护

本分支在保留 Windows / Kimi 2.x 启动适配的基础上，增加 P1 生命周期保护。P0 是业务项目中约定的委派规则；P1 把容易误用的路径变成桥接层的默认检查。

## 解决的问题

Kimi 的一个 session 可以包含当前 prompt 和多个 queued prompts。此前按 session 的瞬时 `idle` 判断完成，可能在排队任务启动前就生成交接结果。中止当前 turn 后，排队 prompt 还可能继续运行。

本次改进包括：

| 场景 | 当前行为 |
| --- | --- |
| 向忙碌 session 发送委派或反馈 | 默认返回 `SESSION_BUSY`，不提交 prompt |
| 确实需要排队 | 显式传 `allowQueue: true`，表示新增排队任务 |
| 一次委派并等待 | 跟踪返回的 `promptId`；任务仍在队列时不生成 `reviewPackage` |
| 从中断或去重恢复 | 返回 idle 前检查队列，避免把两轮之间的空隙当作完成 |
| 中止当前 turn | 返回 `abortRequested`，明确未确认整个 session 停止 |
| 中止并确认 | `kimi_abort_and_wait` 同时观察队列和 session 状态 |
| 旧版服务没有 prompt API | 降级为 session 状态，并标记 `queueEvidence: unavailable` |

## 日常调用

可以在对话中说：

> 请委派 Kimi 按已确认的计划实现，使用 kimi_delegate_and_wait。保留 sessionId 和 promptId；如果超时，继续观察原任务，不要重复提交。完成后由你独立审查 diff 和测试。

调用示例：

```json
{
  "cwd": "C:\\work\\example-project",
  "task": "按确认的方案修复指定问题",
  "acceptanceCriteria": ["目标回归测试通过", "不覆盖已有改动"],
  "plan": ["定位相关实现", "最小范围修改", "运行验证并交接"],
  "timeoutMs": 30000
}
```

返回超时后，使用 `kimi_wait_for_prompt`：

```json
{ "sessionId": "<原 sessionId>", "promptId": "<原 promptId>", "timeoutMs": 30000 }
```

`settled` 仅表示该 prompt 已离开待执行队列，不等于实现成功。还应检查 `sessionStatus`，通过 `kimi_review_package` 获取真实改动并独立验收。`blocked` 表示需处理审批或问题；不要用 `kimi_continue_task` 查询进度。

若此前调用被打断且不知道 promptId，先用 `kimi_find_recent_session` / `kimi_recent_sessions` 恢复 session，再用 `kimi_wait_until_idle` 观察。等待超时不会取消 Kimi。

## 停止和交接

可以在对话中说：

> 请停止这个 Kimi 任务，使用 kimi_abort_and_wait，并核对 terminationConfirmed、activePromptId 和 queuedPromptIds。确认停止之前不要让其他代理接管写入。

```json
{ "sessionId": "<sessionId>", "promptId": "<正在运行的 promptId>", "timeoutMs": 30000 }
```

- `abortRequested: true`：中止请求已被接受。
- `abortRequested: false`：没有发送中止请求；例如队列中没有可识别的 active prompt。已经 idle 时仍可以确认当前无任务。
- `terminationConfirmed: true`：在本次观察中，队列为空且 session 已不在运行或等待交互。
- `terminationConfirmed: false`：尚未确认停止；查看 `finalStatus` 和剩余 prompt ID。
- `finalStatus: queued_prompts_remain`：排队任务仍存在，后续可能执行。
- `queueEvidence: unavailable`：服务不支持队列查询，无法确认整个 session 完全停止。

不传 promptId 时，桥优先定位并中止 active prompt。显式指定 queued prompt 会返回 `QUEUED_PROMPT_NOT_CANCELLABLE`；指定不存在的 prompt 会返回 `PROMPT_NOT_PENDING`，不会改为中止另一个任务。旧服务无法验证指定 prompt 身份时返回 `PROMPT_ABORT_UNAVAILABLE`，不发送中止请求。

保留的 `kimi_abort` 只请求中止当前主 Agent turn。其兼容字段 `aborted: true` 表示请求成功受理，**不是整个 session 已停止的证据**。

## 能力边界

实现依据是 [Kimi 官方 Server API 的 Prompts 和 Session abort 语义](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/server-api.md#prompts)。当前 API 未提供逐条取消 queued prompt 的接口；桥不会伪造清空队列能力，也不会循环中止后来启动的任务。

`GET /prompts` 返回 HTTP 404/405 时，桥按旧服务处理。旧服务若使用通用业务码 40401，需进一步验证 session 存在才降级；真正的 session 不存在、认证和网络错误继续上报。旧服务上的等待仅有 session 级证据，中止确认始终为 false。

提交前检查不是服务端原子锁：其他客户端仍可能在检查和提交之间启动任务。应保持一个 session 只有一个调度方。停止确认是观察时点的状态，不会永久禁止后续提交，也不承诺终止独立外部进程。

本次不修改 Kimi Code 服务、业务项目或其 P0 规则，不自动推送 GitHub。
