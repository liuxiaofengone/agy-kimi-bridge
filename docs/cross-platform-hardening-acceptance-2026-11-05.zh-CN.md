# 跨平台基线问题修复与独立验收

日期：2026-11-05。实施由 Kimi 完成；Codex 对真实 diff、审查包、故障边界和双平台结果独立验收。本记录是此前生命周期与启动验证记录之后的最终状态，不改写历史运行数字。

## 原 10 项失败的处理

| 原失败 | 数量 | 修复与验收 |
| --- | ---: | --- |
| Windows 并发保存 baseline 时 rename 返回 EPERM | 1 | 共享原子写助手，同目录临时文件、写入完成后替换、有限重试；不会先删除旧记录。baseline 与服务发现记录都使用该助手 |
| cwd 尾分隔符匹配及 Git worktree 路径 | 5 | 统一平台路径比较；Git 输出转为 native/canonical 工作区路径；保留 POSIX 大小写、空白和反斜杠语义，避免错误合并项目 |
| 入口保护测试硬编码 POSIX file URL | 2 | 用 native 绝对路径和 pathToFileURL 覆盖本机真实行为，包括空格和非 ASCII 路径；保留非入口导入不自启动的保护 |
| 跨进程 review 测试依赖全局 pnpm | 1 | 直接使用 process.execPath 与项目内 tsx 入口启动真实进程，验证 baseline 跨进程回读及 committedChanges |
| 插件验证依赖原作者 Mac 上的 Python 脚本 | 1 | 改为仓库内 Node 校验器，新增 pnpm validate:plugin；不依赖 Python 或个人目录 |

同时检查并修复了相邻风险：auto 数据目录身份及 URL pathname 的大小写隔离、原无效数据测试写错分区的问题，以及插件验证器的根类型、env 类型、SemVer、真实路径包含关系和诊断脱敏。Windows 无文件 symlink 权限时的测试回退使用新的 junction 路径，并强制注入 EPERM 验证，不依赖管理员或开发者模式。

## Codex 独立验证

最终源码及插件配置相同；Ubuntu 使用独立副本和 Linux 依赖，没有复用 Windows node_modules。

| 检查 | Windows ARM64 | Ubuntu 24.04 / WSL ARM64 |
| --- | --- | --- |
| Node | v26.13.0 | v22.23.4 |
| pnpm | 12.16.1 | 10.34.9 |
| 全量 Vitest | 376/376，通过；0 失败、0 跳过 | 376/376，通过；0 失败、0 跳过 |
| 测试文件 | 20 | 20 |
| pnpm typecheck | 通过 | 通过 |
| pnpm build（含 tracked bundle） | 通过 | 通过 |
| pnpm validate:plugin | 通过 | 通过 |

额外独立压力测试：4 个真实写入进程，共 160 次保存；从预先发布的 baseline 开始持续读取，每次都必须取得完整有效记录。结果通过，无遗留临时文件。故障注入回归另验证重试耗尽时旧文件仍在、永久错误快速失败、瞬态冲突恢复后成功。

源码审查提出的 Important 均已修复并复核，无剩余 Critical/Important。坏包 fixtures 实际执行验证器，覆盖缺失文件、根外 manifest/skill 链接、绝对 cwd、损坏 JSON、非法类型、非字符串 token 和非法版本；没有靠跳过或削弱断言消除失败。

## 安装缓存与真实调用

已安装本地开发版 `0.3.0+codex.20261105225600`。缓存中的 manifest、MCP 配置、skill、bundle 与源码逐项 SHA-256 比对一致。

从实际缓存启动 MCP，Kimi 2.5.0 自动发现服务后 health/auth 均通过；一次仅回复 `KIMI_AUTO_PORT_OK` 的真实委派成功，prompt settled、session idle，临时 Git 工作区无改动。开发修复会话交接也核对了 committedChanges 与 workingTreeChanges，未把未提交修改误认为已提交交付。

新版本需要在**新的 Codex 对话**中加载。当前聊天已经启动的旧 MCP 进程不会因重新安装而自动变成新版；不要用旧进程的结果替代新缓存验收。

## 可补入 AGENTS / quickstart 的开发验收规则

以下用于**修改或升级桥接源码后**，不要求每次业务委派前重跑桥的全部测试：

```text
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm validate:plugin
```

- 不把“历史基线失败”当作验收豁免；失败、跳过或未执行检查必须明确记录并处理。
- 路径与子进程相关修改应使用真实本机路径、进程和临时 Git 仓库验证；跨平台结论需注明实际运行过的平台。
- MCP 运行时代码修改后，提交重新生成的 plugins/kimi-delegate/mcp/server.mjs；完成活动委派后刷新插件缓存，并在新对话验证实际调用。
- baselineStored 为 false 或交接证据 available 为 false 时，不得据此判断“没有改动”；核查原因，并通过真实 Git 证据完成审查。
- 首次安装仍可使用仓库已跟踪的 bundle，无需上述源码开发工具；Kimi Code 的安装和登录仍是前置条件。

## 兼容边界

默认本机根 URL 的既有 baseline 分区保持兼容。旧代码曾将 URL pathname 整体小写；现在保留大小写以隔离不同服务路径，因此使用大小写敏感子路径的自定义端点，旧记录可能仍在原分区。不会自动混读旧分区而把另一个端点的证据用于当前会话；此类历史证据应按原端点和真实 Git 记录人工核对。

验证覆盖上述 Windows 与 Ubuntu WSL 环境；未将参数化路径测试冒充 macOS 真机验收。测试 JSON 和临时运行环境保留在忽略/临时目录，不提交含本机环境信息的原始日志。
