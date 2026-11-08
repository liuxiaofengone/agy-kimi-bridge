# Kimi 委派中文规则与 quickstart 补充稿

整理日期：2026-11-06。依据当前桥接源码、插件配置及 2026-11-05 最终验收记录整理。

这份文档交给负责业务项目 `AGENTS.md`（或项目实际使用的 `agent.md`）与 quickstart 的 agent 使用。第二部分可合并进长期规则，第三部分可合并进 quickstart；第四部分仅适用于维护桥接源码。

## 一、给文档维护 agent 的更新要求

- 保留项目现有规则；将本稿与已有 Kimi 章节合并，消除重复和冲突，避免追加两套互相矛盾的流程。
- 替换旧的固定端口、每次必须手工启动 Kimi、超时就重新委派、中止请求受理就可以移交等表述。
- P0 是业务项目的委派与所有权规则；P1 是桥接层的默认检查。两者共同使用，桥接检查不能替代项目调度规则。
- 不将本机目录、某次运行返回的端口、临时开发版本号、历史测试数量写成永久要求。
- 更新后检查工具名、字段和 JSON 格式；向用户报告改了哪些章节、清除了哪些旧表述，以及尚未实际验证的内容。
- 本稿不增加提交、推送或发布权限；这些操作遵循用户与目标项目已有授权。

## 二、可合并进 AGENTS.md 的长期规则

以下代码块是可直接采用的规则正文。

```markdown
### Kimi 委派规则

#### 职责与写入所有权

- 用户指定 Kimi 实现时，主 agent 负责需求、计划、验收标准、审查和独立验证，Kimi 负责具体实现。Kimi 不可用时报告阻塞，不擅自改由其他实现者接管。
- 每个 Kimi session 只由一个调度方提交工作。同一工作区内有重叠文件范围的任务只保留一个实现者；需要并行时明确文件所有权，并使用适当隔离。
- 委派前记录实际 cwd、Git HEAD 和已有修改。明确允许修改的文件或模块、禁止范围、验收标准、验证命令及交接要求，保留用户与其他 agent 的已有改动。

#### 启动与连接

- 默认使用 KIMI_SERVER_URL=auto 和 KIMI_SERVER_ARGS=["web","--no-open"]，由桥接服务让 Kimi 绑定系统分配的本机端口。不得将 58627 或其他某次返回的端口固化进规则、脚本或健康检查。
- 地址使用 kimi_bridge_status 返回的 serverUrl / webBaseUrl；查看任务使用返回的 webUrl。
- 首次使用、更新后或连接异常时，先调用 kimi_recent_sessions 触发预检查及必要的自动启动，再调用 kimi_bridge_status。只有 status=ready、healthzOk=true、authOk=true 后才提交开发任务。
- kimi_bridge_status 本身不启动服务；单次 server_unreachable 不能证明 CLI 不兼容。预检查仍失败时，依据脱敏诊断排查并暂停开发委派。
- 不通过关闭鉴权、扩大监听范围、泄露 token 或终止无关服务绕过连接问题。

#### 模型选择与限流切换

- 本对话第一次委派前，调用 kimi_list_models，列出 id、displayName、上下文长度和当前默认模型，请用户选定一个模型。用户选定后，本对话后续委派和续跑都显式传入同一个 model，不再每次询问。
- 用户已在规则或本对话中指定模型时直接使用，不再询问；若该 id 不在 kimi_list_models 结果中，先报告再请用户改选。
- 只在以下情况重新请用户选择：调用返回 code=KIMI_RATE_LIMITED；或等待结果 diagnostics.rateLimited=true；或用户主动要求换模型。
- KIMI_RATE_LIMITED 带 submissionState: not_submitted，表示该 prompt 未被接受。用户选定新模型后，用 kimi_continue_task(sessionId, model=新模型) 在原 session 重新提交同一指令。
- diagnostics.rateLimited=true 表示 prompt 已开始执行后才被限流，可能留下部分改动。先确认没有活动或排队的 prompt（必要时 kimi_abort_and_wait 并检查 terminationConfirmed），再用新模型在原 session 续跑，并要求 Kimi 先核对已有改动再继续，不新开 session 重做。
- 换模型后在交付报告中注明各阶段使用的模型。

#### 提交、等待与恢复

- 正式委派优先使用 kimi_delegate_and_wait，记录返回的 sessionId、promptId 和 webUrl。
- 使用稳定且具体的任务标题；使用 dedupe 时令 titleContains 对应该标题。默认保持 cwd-safe，不开启 matchAnyCwd；只有明确要跨工作区恢复时才改变这一范围。
- 发生中断、等待超时或疑似重复任务时，先恢复原 session。已知 promptId 用 kimi_wait_for_prompt；未知时先用 kimi_find_recent_session / kimi_recent_sessions 查找，再用 kimi_wait_until_idle 观察。需要恢复判断时可启用 includeSummary: true。
- 等待超时不等于任务取消。不得再次提交相同任务或用 kimi_continue_task 查询进度；kimi_continue_task 会提交新的工作指令。
- 保持 SESSION_BUSY 默认保护。allowQueue: true 只用于明确决定新增排队任务，不用于查询、替换或停止当前任务。
- dedupe 命中 idle session 时先审查已有结果；复用不表示新指令已经执行。failed / aborted session 不会被自动复用，先查明状态与已有改动，再决定是否用 kimi_continue_task 继续原会话。
- settled 只表示指定 prompt 已离开待执行队列；idle 只是运行状态。必须结合 sessionStatus、queueEvidence 和真实交付验收，不能据此直接宣告成功。
- 遇到 awaiting_approval / awaiting_question 时处理原会话的审批或问题，不重复追加 prompt。

#### 失败与停止

- 只有返回 submissionState: not_submitted 时，才将该次失败调用认定为未创建/提交 session 或 prompt；该字段不证明其他历史调用没有在运行。
- 若 startupMayStillBeRunning=true，先核实本次启动进程状态再重试。启动超时与提交后的等待超时必须分开处理。
- 需要停止并移交时使用 kimi_abort_and_wait，检查 terminationConfirmed、activePromptId、queuedPromptIds、finalStatus 和 queueEvidence。未确认停止前不让另一实现者接管重叠文件。
- abortRequested / aborted 仅表示中止请求受理；不证明排队任务已清空。queueEvidence=unavailable 时，桥接服务不能确认完整终止，应继续核查并保留写入所有权。
- 支持的 API 无法逐条取消 queued prompt；不得通过反复中止后来启动的 turn 模拟清空队列。
- terminationConfirmed=true 是观察时点的状态，不保证独立外部进程已终止，也不能阻止其他客户端随后提交工作。

#### 交付与独立验收

- 获取 embedded reviewPackage 或调用 kimi_review_package，审查 committedChanges 与 workingTreeChanges，并用 initialDirtyPaths 区分委派前已有修改。
- 工作区干净不代表没有交付；Kimi 可能已经提交。检查 reviewWorkspace，确保 Git log、diff 与测试针对真正产生改动的工作区。
- baselineStored=false 或 available=false 表示基线/证据缺失，不能解释为没有改动。读取具体原因，使用委派前记录、真实 Git log / diff 补充审查；证据不足时明确报告。
- 出现 review_workspace_mismatch 或 ambiguous_worktrees 时先定位真实工作区，再验收，不将其他工作区的改动归入本任务。
- 主 agent 必须独立检查真实 diff 并运行与变更相符的验证；Kimi 的完成报告、服务 ready 和 prompt settled 不能替代验收。
- 发现问题后将具体反馈通过 kimi_continue_task 发回原会话，继续遵守忙碌保护与同一写入所有权规则。
- 不以“历史基线失败”豁免测试失败；确认根因并处理，未解决的失败、跳过或未执行检查要明确报告。

#### 插件更新

- 刷新插件缓存前先结束活动委派并确认状态；安装或更新后打开新的 Codex 对话加载新版 MCP。
- 分别记录安装状态、实际加载配置、真实工具调用及任务交付证据；旧聊天中的旧 MCP 进程不能用于证明新版本可用。
```

## 三、可合并进 quickstart 的操作说明

### 1. 前置条件与配置

先安装 Kimi Code 并完成登录。默认自动发现模式要求 Kimi 支持 `web --port 0`；本次实际验证的是 Kimi 2.5.0。需要手工管理或使用旧版服务时，按该版本支持的启动方式配置明确 URL，不套用自动发现步骤。

在桥接仓库的 `plugins/kimi-delegate/.mcp.json` 中，核对相应服务的 `env`。以下只是 `env` 字段片段，合并时保留其余设置：

```json
{
  "KIMI_SERVER_URL": "auto",
  "KIMI_AUTO_START": "true",
  "KIMI_COMMAND": "kimi",
  "KIMI_SERVER_ARGS": "[\"web\",\"--no-open\"]",
  "KIMI_CODE_HOME": "",
  "KIMI_SERVER_TOKEN": ""
}
```

`KIMI_SERVER_ARGS` 的值是 JSON 数组的字符串形式。不要手工附加固定端口；桥会补充 `--port 0 --host 127.0.0.1`。

若 `kimi` 不在 PATH，设置 `KIMI_COMMAND` 为本机实际可执行文件路径；自定义 `KIMI_CODE_HOME` 时，与登录所用的数据目录保持一致。`KIMI_SERVER_TOKEN` 保持为空，默认从本机 token 文件读取，不将真实 token 写入仓库。

按项目已有流程安装或刷新插件，随后打开新的 Codex 对话。首次安装可以使用仓库已跟踪的 bundle，不要求先跑源码开发测试。日常业务委派也不需要反复重装插件。

### 2. 先检查连接，不提交开发任务

在新对话中说：

```text
请先调用 kimi_recent_sessions，触发 Kimi 预检查和必要的自动启动；
再调用 kimi_bridge_status，核对 status=ready、healthzOk=true、authOk=true。
告诉我返回的实际 serverUrl / webBaseUrl。本次只检查连接，不创建开发任务。
```

这一步会查询已有会话，必要时启动服务，但不会创建实现任务。Kimi 已正常运行时，无需手动再启动一个服务。

### 3. 安装或更新后的真实调用验收

连接通过后，可在临时 Git 工作区做一次无修改的真实调用：

```text
请在临时 Git 工作区使用 kimi_delegate_and_wait 做一次真实调用，
要求 Kimi 只回复 KIMI_BRIDGE_SMOKE_OK，不修改文件、不运行项目开发任务。
保留 sessionId / promptId，检查实际回复、sessionStatus 和 queueEvidence，
并核对调用前后 Git 状态与 diff，确认未产生改动。等待超时后观察原任务，不重复提交。
```

实际回复和无改动证据一起构成这次 smoke 的结果。仅安装成功或 health/auth 通过，不能证明模型调用成功。这一步用于安装、更新或排障后的验收，不要求每次业务委派重复执行。

### 4. 正式委派时可以这样说

```text
请使用 Kimi 实现：<需求内容>。
你负责计划、验收标准和独立审查，Kimi 负责实现。
请明确工作目录、允许修改范围、现有改动和验证要求，使用 kimi_delegate_and_wait。
设置稳定且具体的 dedupe 标题，保持 cwd-safe，并保留 sessionId / promptId。
如果超时，继续观察原任务，不重复提交。
完成后检查 reviewPackage 的 committedChanges 与 workingTreeChanges，
独立检查真实 diff 和测试，再向我报告结果。提交与推送按项目已有授权执行。
```

首次委派时主 agent 会先列出 Kimi 模型让你选择；之后同一对话沿用该模型，遇到 429 限流才会再请你换模型。也可以直接在需求里写“使用模型 <模型 id>”。

### 5. 中断、超时后可以这样说

```text
请恢复刚才的 Kimi 委派，不新建相同任务。
已知 promptId 时用 kimi_wait_for_prompt；否则先查最近会话，
结合标题、cwd、状态和 includeSummary 恢复原 session，再继续观察。
告诉我当前是在运行、等待交互、失败，还是可以进入交付审查。
```

### 6. 常见状态的处理

| 返回结果 | 应如何处理 |
| --- | --- |
| `server_unreachable` | 先用 `kimi_recent_sessions` 触发预检查，再核对状态；不要仅凭此结果判断 CLI 更新不兼容 |
| `KIMI_STARTUP_FAILED` / `KIMI_STARTUP_TIMEOUT` / `KIMI_AUTH_FAILED` | 查看脱敏诊断与 `submissionState`；明确未提交后处理启动/鉴权原因；仍可能有启动进程时先核查 |
| 已有 session / prompt 的等待超时 | 继续观察原任务，超时不会取消工作 |
| `KIMI_RATE_LIMITED`（`not_submitted`） | 列出模型请用户改选，用 `kimi_continue_task` 在原 session 以新模型重新提交 |
| `diagnostics.rateLimited=true` | 确认原 prompt 已停止后，请用户改选模型，在原 session 续跑并先核对已有改动 |
| `SESSION_BUSY` | 保留当前任务，观察其状态，不用 `allowQueue` 绕过保护 |
| `blocked` / 等待审批或问题 | 在原会话处理对应交互，不重复提交任务 |
| `settled` / `idle` | 检查状态、队列及真实改动，再决定是否通过验收 |
| `terminationConfirmed=false` / `queueEvidence=unavailable` | 停止尚未证实，继续核查，不移交重叠文件写入 |
| `baselineStored=false` / 交接证据 `available=false` | 核查原因并用直接 Git 证据补足审查，不能据此判断没有改动 |

## 四、仅供桥接源码维护者使用的验收补充

以下命令在 `codex-kimi-bridge` 仓库执行，不要作为所有业务项目每次委派的前置要求：

```text
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm validate:plugin
```

- 修复路径、持久化或进程启动行为后，使用真实本机路径、子进程和临时 Git 仓库验证；跨平台结论注明实际运行的平台。
- 不靠跳过断言或忽略历史失败消除问题；沙箱限制与真实回归分别举证。
- MCP 运行时代码变更后，重新生成并提交 `plugins/kimi-delegate/mcp/server.mjs`。
- 活动委派结束后按仓库流程刷新插件缓存，新开对话检查实际加载版本并完成连接与真实调用验收。
- 本次 2026-11-05 验收记录为 Windows ARM64 与 Ubuntu 24.04 / WSL ARM64 各 376/376 测试通过，且 typecheck、build、validate:plugin 通过。这是历史验收证据，后续变更须重新验证，不将该数量写成固定门槛。

## 五、对应依据

- [自动端口发现与启动故障恢复](kimi-startup-recovery.zh-CN.md)
- [Kimi 委派生命周期保护](kimi-lifecycle-guardrails.zh-CN.md)
- [跨平台基线问题修复与独立验收](cross-platform-hardening-acceptance-2026-11-05.zh-CN.md)
- [委派提示词模板](prompts/kimi-delegate-workflow.md)

本稿只整理当前实现已有的行为与操作规则，没有新增桥接能力，也没有执行新的开发委派。
