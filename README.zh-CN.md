# Codex Kimi Bridge（中文说明）

[English](README.md) | **简体中文**

让 Codex 负责需求理解、任务规划和代码审查，让 Kimi Code 执行具体开发任务。本项目通过本地 MCP 服务连接两者，你可以直接在 Codex 对话中委派工作。

**本分支重点改进现代 Kimi 自动启动、Windows 使用体验和委派任务的生命周期管理。** 安装并完成 Kimi Code 自身的账号登录后，首次委派会按需启动 Kimi 服务；在继续、等待或停止任务时，桥接层也会检查 prompt 队列，帮助避免重复委派和过早交接。

本项目基于 [ximenchuifeng/codex-kimi-bridge](https://github.com/ximenchuifeng/codex-kimi-bridge)，保留原作者署名与 MIT 许可证。启动适配改动已通过 [上游 PR #1](https://github.com/ximenchuifeng/codex-kimi-bridge/pull/1) 提交。

## 本分支的特点

以下对比针对上游基线 [`459d95c`](https://github.com/ximenchuifeng/codex-kimi-bridge/commit/459d95c)：

| 使用场景 | 上游基线 | 本分支 |
| --- | --- | --- |
| 自动启动现代 Kimi | 固定使用 `kimi server run --keep-alive` | 插件使用 `kimi web --no-open`，已验证 Kimi 2.5.0 |
| 端口冲突 | 默认固定 58627，冲突时启动失败 | `KIMI_SERVER_URL=auto`，由 Kimi 以 `--port 0` 请求系统分配端口，发现并鉴权后复用 |
| 启动失败诊断 | 早退错误容易退化成健康检查超时 | 就绪前持续观察子进程，返回退出码、安全错误码和任务未提交标记 |
| 自定义启动方式 | 启动参数写在代码中 | 新增 `KIMI_SERVER_ARGS`，通过 JSON 字符串配置参数，并保留旧版回退 |
| Windows 后台运行 | 后台启动未设置 `windowsHide` | 隐藏启动控制台，默认不自动打开浏览器 |
| 空数据目录配置 | 子进程可能继承空的 `KIMI_CODE_HOME` | 统一解析为 `~/.kimi-code`，使子进程与桥接服务使用一致的认证目录 |
| Windows 启动诊断 | 启动命令采用 POSIX 引号规则 | 使用 PowerShell 调用和引号规则，支持带空格、单引号的路径与参数 |
| 向已有会话继续委派 | 提交前不检查会话及队列是否忙碌 | 默认返回 `SESSION_BUSY`；确需新增排队任务时显式设置 `allowQueue: true` |
| 等待委派完成 | 主要按会话状态判断，可能遇到队列切换时的短暂空闲 | 跟踪本次 `promptId` 并检查队列，避免把短暂空闲误认为完成 |
| 超时后恢复 | 需要结合会话状态自行判断 | 可用 `kimi_wait_for_prompt` 继续观察原 prompt，避免重复提交 |
| 停止与交接 | 中止请求受理不代表整个会话已停止 | `kimi_abort_and_wait` 观察会话和队列，返回停止确认结果及剩余排队任务 |
| Windows 基线并发保存 | 并发替换文件可能触发 EPERM | 原子写入、有限重试并保留旧记录；覆盖多进程并发读取和写入 |
| 路径与开发环境 | 部分路径和验证命令包含平台假设 | 统一平台路径比较与 Git native 工作区输出；项目内 Node 校验器及本地 tsx 子进程入口 |
| 中文上手 | 主要说明使用英文 | 提供中文安装、配置、委派示例和常见问题说明 |

本分支沿用上游的任务委派、审查包、会话恢复等能力。已运行且健康的服务会被复用；`kimi_bridge_status` 只检查状态，不触发启动。仓库包含构建好的 MCP 安装包，首次安装无需 pnpm 或 TypeScript 编译。

队列保护的完整判断依赖 Kimi 服务支持 prompt 队列查询；旧服务会标记 `queueEvidence: "unavailable"`，无法确认整个会话已停止。提交前检查不是跨客户端的服务端锁，排队任务也无法逐条取消；prompt 离开队列不等于开发成功，仍需检查交接、代码 diff 和测试。详细语义见 [Kimi 委派生命周期保护](docs/kimi-lifecycle-guardrails.zh-CN.md)。

## 快速安装

### 环境要求

- Git。
- Node.js 20 或更新版本。
- 支持插件的 Codex。
- 已安装并完成账号登录的 [Kimi Code](https://github.com/MoonshotAI/kimi-code)。现代启动方式已在 Kimi 2.1.1 上验证；其他版本可按下文调整参数。

首次使用 Kimi Code 时，可运行 `kimi`，再在其交互界面使用 `/login` 完成登录。Windows 用户需安装 Git for Windows，供 Kimi 使用 Git Bash。详细步骤见 [Kimi Code 官方安装与登录说明](https://github.com/MoonshotAI/kimi-code#install)。

先确认终端能找到所需命令：

```text
git --version
node --version
codex --version
kimi --version
```

如果 Codex 继承的 `PATH` 中找不到 `kimi`，请在安装前按下文设置可执行文件的完整路径。

### Windows PowerShell

在希望存放项目的目录打开 PowerShell，运行：

```powershell
git clone https://github.com/liuxiaofengone/codex-kimi-bridge.git
Set-Location codex-kimi-bridge
codex plugin marketplace add (Get-Location).Path
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

### macOS / Linux

```bash
git clone https://github.com/liuxiaofengone/codex-kimi-bridge.git
cd codex-kimi-bridge
codex plugin marketplace add "$PWD"
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

安装后打开一个新的 Codex 对话，使插件工具加载生效。可以运行 `codex plugin list`，确认 `kimi-delegate@codex-kimi-bridge-local` 已安装并启用。

## 在对话中委派 Kimi 工作

### 简单任务

直接在 Codex 对话中输入：

```text
请用 kimi-delegate 让 Kimi 完成这个需求：为当前项目增加登录表单的输入校验。
你负责制定计划、审查改动并运行验证，具体实现交给 Kimi。
完成后告诉我修改了哪些文件、验证结果和 Kimi 会话链接。
```

需要启动服务时，任务调用会自动执行默认启动命令；你无需提前手动运行 `kimi web`。

### 明确范围与验收标准

```text
请使用 kimi-delegate 完成以下任务。

项目：当前工作区。
需求：修复登录表单在邮箱为空时仍能提交的问题。
范围：只修改登录表单及相关测试。
验收标准：空邮箱不能提交；合法邮箱保持原有行为；相关测试通过。

Codex 负责分析、计划和审查，Kimi 负责实现。
委派时优先使用 kimi_delegate_and_wait，并用稳定任务关键词设置 dedupe，
保留默认的工作目录匹配，避免中断后重复创建任务。
审查不通过时，用 kimi_continue_task 让 Kimi 修正。
完成后给出会话链接、改动摘要和验证结果。
```

### 继续之前的任务

```text
请继续刚才的 Kimi 任务，补充手机号格式校验。
优先沿用原会话；如果会话信息不在当前上下文中，先按任务关键词查找并确认工作目录。
完成后继续审查并验证。
```

如果 Kimi 正在等待批准或回答问题，可以打开返回的 `webUrl` 处理，再继续同一会话。等待超时不会停止任务：保留 `sessionId` 和 `promptId`，优先用 `kimi_wait_for_prompt` 继续观察；如果没有 `promptId`，先查找原会话并用 `kimi_wait_until_idle` 观察。`failed` 或 `aborted` 会话不会被自动去重复用，需要检查原因后再决定是否用 `kimi_continue_task` 继续。

### 停止任务并确认交接

```text
请使用 kimi_abort_and_wait 停止刚才的 Kimi 任务，检查 terminationConfirmed 和剩余排队任务；确认停止前不要让其他代理接管写入。
```

`kimi_abort` 只请求中止当前主 Agent turn；`terminationConfirmed: true` 表示在本次观察时队列为空且会话不在运行或等待交互。停止确认不保证外部独立进程已经退出，也不能阻止其他客户端之后再次提交任务。

更完整的主控、实现与审查模板见 [委派工作流示例](docs/prompts/kimi-delegate-workflow.md)。

## 启动与认证配置

配置文件为 [plugins/kimi-delegate/.mcp.json](plugins/kimi-delegate/.mcp.json)，相关变量放在 `mcpServers.kimi-delegate.env` 中。需要修改时，建议先配置再安装；已安装插件可按 [修改配置后重装](#修改配置后重装) 刷新缓存。

| 变量 | 插件默认值 | 用途 |
| --- | --- | --- |
| `KIMI_AUTO_START` | `true` | 服务未响应时，在任务调用前自动启动；设为 `false` 可手动管理服务 |
| `KIMI_COMMAND` | `kimi` | 启动的可执行文件，可设置为完整路径 |
| `KIMI_SERVER_ARGS` | `["web","--no-open"]`，以 JSON 字符串保存 | 自动模式补充 `--port 0 --host 127.0.0.1`；旧版服务需显式地址并将参数设为空字符串 |
| `KIMI_SERVER_URL` | `auto` | 自动发现系统分配的本机端口；手动管理服务时也可填写明确 URL |
| `KIMI_CODE_HOME` | 空字符串，解析为 `~/.kimi-code` | Kimi 数据和认证目录；自定义时应与 Kimi Code 保持一致 |
| `KIMI_SERVER_TOKEN` | 空字符串 | 默认自动读取本地 token；需要显式覆盖时才设置 |
| `KIMI_PREFLIGHT_CACHE_MS` | `5000` | 成功预检查的缓存时间，单位为毫秒；`0` 表示禁用缓存 |

### 默认现代启动方式

下面是 `env` 中相关字段的配置示例：

```json
{
  "KIMI_AUTO_START": "true",
  "KIMI_COMMAND": "kimi",
  "KIMI_SERVER_URL": "auto",
  "KIMI_SERVER_ARGS": "[\"web\",\"--no-open\"]",
  "KIMI_CODE_HOME": "",
  "KIMI_SERVER_TOKEN": ""
}
```

`KIMI_SERVER_ARGS` 必须是 JSON 数组字符串，数组非空且每一项都是非空白字符串。参数直接传给可执行文件，不经过 shell 拆分。自动模式让 Kimi 在绑定时由系统分配端口，避免固定端口冲突和“先探测、后绑定”的竞争；仅监听 `127.0.0.1`，保留正常鉴权。

发现结果和启动锁保存在 `KIMI_BRIDGE_STATE_DIR` 下，按 Kimi 数据目录隔离，不保存 token 或原始启动日志。MCP 重启后可复用已经鉴权的服务；地址失效时，下次任务调用会重新启动并发现地址。自动模式的 Git 基线也按数据目录标识保存，端口变化不影响后续交接证据。

如果服务由你手动管理，将 `KIMI_SERVER_URL` 设为实际 URL；使用 `web` 时可省略 `--port`，桥会从 URL 派生。显式参数与 URL 端口不一致时，桥会拒绝启动。自动模式已在 Kimi 2.5.0 验证，旧版请使用明确地址和对应启动命令。详见 [启动恢复与项目规则建议](docs/kimi-startup-recovery.zh-CN.md)。

### Windows 可执行文件路径

如果 `kimi` 不在 Codex 继承的 `PATH` 中，先在 PowerShell 查询实际位置：

```powershell
(Get-Command kimi).Source
```

然后设置 `KIMI_COMMAND`。例如，下面是合法的 JSON 路径写法，请替换为你实际的安装位置：

```json
{
  "KIMI_COMMAND": "C:\\Program Files\\Kimi Code\\kimi.exe"
}
```

JSON 中的反斜杠需要转义，不要给配置值额外添加 PowerShell 引号或 `&`。

### 使用旧版 Kimi

如果已安装的 Kimi 提供 `server` 子命令，将 `KIMI_SERVER_URL` 设为该服务的实际地址、`KIMI_SERVER_ARGS` 设为 `""`，任务自动启动时就会回退到：

```bash
kimi server run --keep-alive
```

也可以按该版本提供的方式手动管理服务。桥接服务会复用已运行的健康实例。

### 自动读取认证信息

token 的读取顺序为：非空 `KIMI_SERVER_TOKEN`、自定义 `KIMI_CODE_HOME/server.token`、`~/.kimi-code/server.token`。本分支让自动启动的 Kimi 使用解析后的数据目录，修复空目录配置导致认证文件位置不一致的问题。

正常使用保留认证，不需要手工复制 token，也不需要关闭认证。发布配置中的 token 保持为空，请勿把真实凭据提交到仓库。

### 修改配置后重装

在注册为本地插件市场的仓库中修改 `.mcp.json`。待当前委派任务结束后，移除已安装插件及其本地缓存，再从该市场重新安装：

```text
codex plugin remove kimi-delegate@codex-kimi-bridge-local
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

随后打开新的 Codex 对话。这种方式不依赖原作者机器上的缓存版本脚本，也无需为配置修改重新编译 MCP 安装包。若你的 Codex CLI 不提供相同命令，先运行 `codex plugin --help` 查看当前版本支持的操作。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 对话中没有 `kimi-delegate` 工具 | 用 `codex plugin list` 确认安装和启用状态，再打开新的 Codex 对话；必要时重启 Codex |
| 诊断为 `server_unreachable` | 检查可执行文件路径、端口和启动参数；状态检查本身不会启动服务，实际任务调用才会尝试自动启动 |
| 返回 `KIMI_STARTUP_FAILED` / `EACCES` | 查看安全错误码和诊断命令；Windows 无 LISTEN 不代表端口可绑定，还需检查绑定/出站记录和排除范围。优先使用自动端口模式 |
| 提示不支持 `server` 或 `web` 子命令 | 根据已安装版本的 `kimi --help` 调整 `KIMI_SERVER_ARGS`，参考现代配置或旧版回退说明 |
| 诊断为 `auth_failed` | 检查桥接服务与 Kimi 服务的数据目录及 `server.token` 是否一致；如显式设置了 `KIMI_SERVER_TOKEN`，确认它与当前服务 token 一致 |
| 需要查看 Kimi 的执行过程 | 打开工具返回的 `webUrl`；自动启动时默认不会替你打开浏览器 |
| 原任务中断或等待超时 | 保留会话 ID 和 prompt ID，先观察原任务；尚未结束时不要重复提交 |
| 返回 `SESSION_BUSY` | 先等待或处理已有任务；仅在确实要新增排队任务时使用 `allowQueue: true` |
| 停止后 `terminationConfirmed` 为 `false` | 检查会话状态、排队 prompt 和 `queueEvidence`；确认停止前不要移交写入权限 |

`auth_failed` 表示桥接服务访问 Kimi 服务时的 token 认证失败，与 Kimi 模型账号登录是不同环节。`kimi_bridge_status` 不重新读取 token；实际任务的预检查会在认证失败时重新读取并重试，必要时也可重启 MCP 服务以重新加载认证配置。

需要检查服务时，可以在 Codex 对话中说：

```text
请调用 kimi_bridge_status，检查 Kimi 服务和认证状态，并解释返回的诊断结果。
```

## 验证与贡献

当前最终验收：**Windows 与 Ubuntu WSL 均为 376/376 通过，0 失败、0 跳过**；两端类型检查、构建和插件校验均通过。此前 10 项基线失败已逐项修复，并补充并发、故障注入和坏包回归，详见 [跨平台修复与独立验收](docs/cross-platform-hardening-acceptance-2026-11-05.zh-CN.md)。

启动适配曾在 Windows 和 Kimi 2.1.1 上完成真实认证冷启动委派验证。生命周期保护于 2026-11-05 在 Kimi 2.5.0 上完成实际 MCP 调用验证；定向测试 92/92、类型检查及构建通过。该次完整测试为 299/309 通过，剩余 10 项在同环境的原始基线也有失败，涉及 Windows 路径、文件操作、子进程启动及外部脚本路径；详细结果和能力边界见 [验证记录](docs/kimi-lifecycle-verification-2026-11-05.md)。

本地开发可使用：

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm validate:plugin
```

`pnpm validate:plugin` 运行仓库内的 `scripts/validate-plugin.mjs`（Node >= 20，不依赖 Python 或个人目录路径），校验 manifest 必填字段、插件根内的 skill/MCP/bundle 路径、可移植 MCP 打包结构，并拒绝内置 token 值或机器相关路径。

修改 MCP 运行时代码后，应重新构建并提交 `plugins/kimi-delegate/mcp/server.mjs`。文档更新不需要重新构建安装包。

欢迎向本分支提交 [Pull Request](https://github.com/liuxiaofengone/codex-kimi-bridge/pulls)，也可以通过 [上游 Issues](https://github.com/ximenchuifeng/codex-kimi-bridge/issues) 反馈通用问题。反馈时请注明操作系统、Kimi 版本、启动配置和已脱敏的诊断结果。

项目使用 [MIT 许可证](LICENSE)。感谢原作者 [ximenchuifeng](https://github.com/ximenchuifeng) 提供委派与审查桥接的基础实现。
