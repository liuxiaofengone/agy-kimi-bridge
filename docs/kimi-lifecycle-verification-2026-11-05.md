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

---

# 跨平台基线加固验收记录（第二轮）

日期：2026-11-05（同日第二轮）。任务：`baseline10-cross-platform-hardening`。目标：修复第一轮记录中仍失败的 10 项基线失败，并核查相邻跨平台链路。上方第一轮表格与失败清单保留历史语义，其数字描述的是加固前的状态。

## 逐项根因与修复

| # | 失败用例 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `FileBaselineStore survives concurrent saves for the same session` | Windows 并发 replace rename 触发 EPERM，原实现直接抛出 | 新增 `src/atomic-write.ts`：唯一临时文件 + rename 覆盖（从不先删目标），write+fsync+rename，Windows 瞬态共享冲突（EPERM/EACCES/EBUSY/ENOTEMPTY/EEXIST）有界指数退避重试（6 次），其余错误立即抛出；`baseline-store.ts` 与相邻 `server-discovery.ts` 的 `ServerDiscovery.save` 共用该助手 |
| 2-4 | 三项 `NodeGitInspector` worktree 选择/歧义用例 | `git worktree list` 在 Windows 输出正斜杠路径，与 `realpath` 的 native 路径输出契约不一致 | 输出契约定为 canonical native 路径：`resolveReviewWorkspace` 对 selected/fallback/candidates 统一经 `toCanonicalNativePath`（realpath，失败回退 `path.resolve`）；worktree 匹配键统一走 `normalizeWorkspacePathForCompare` |
| 5-6 | 两项 `isDirectExecution` 用例 | 测试硬编码 POSIX file URL 与 POSIX 绝对路径，Windows 下不成立；实现本身正确 | 测试改用 `pathToFileURL` + native 绝对路径，覆盖空格/非 ASCII/点段，并新增"仅 Windows 视正斜杠 argv 为等价"的平台行为断言；保留 bundle 单次启动门禁断言 |
| 7 | `bridge integration persists baseline across processes` | `execFile('pnpm', ['exec','tsx',...])` 依赖全局 pnpm PATH，Windows ENOENT | 改用 `process.execPath` + 仓库内 `tsx/cli` 入口（`createRequire(...).resolve('tsx/cli')`），无 shell 插值、无全局 PATH 依赖；跨进程 baseline/committedChanges/reviewWorkspace 断言不变且通过 |
| 8 | `Codex plugin package passes local plugin validation` | 测试写死 macOS 个人目录下的 Python 脚本 | 新增仓库内 `scripts/validate-plugin.mjs`（Node >= 20，零依赖）：校验 manifest 必填字段、插件根内 skill/MCP/bundle 路径、可移植 MCP 打包结构、token 必须为空、无机器相关路径/凭据；`test/plugin.test.ts` 增加真实负向 fixture（缺 SKILL.md、内置 token、缺 bundle 均必须失败） |
| 9-10 | 两项 cwd 尾分隔符匹配用例 | `normalizeCwd` 只剥离 `/`，Windows 下 `path.normalize` 产生带尾反斜杠的路径 | 新增 `src/paths.ts` 统一平台比较键：Windows 兼容正/反斜杠、盘符与路径小写（文件系统大小写不敏感）、UNC/根目录保留、点段折叠；POSIX 保留大小写（大小写敏感）；`tools.ts` dedupe/find 与 `git.ts` worktree 比较共用 |

## 本轮自动化验证

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest（JSON reporter，同第一轮运行方式） | 340 通过 / 0 失败 / 0 跳过（19 个文件） |
| `pnpm test`（重建 bundle 后复跑） | 340/340 通过 |
| baseline/server-discovery 并发套件连续 10 次复跑 | 170/170 通过（原 EPERM 用例稳定） |
| 新增回归：`test/paths.test.ts`（双平台规则参数化）、baseline 跨实例并发、读写并发不见部分 JSON、无临时文件残留、替换不删目标 | 全部通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build`，含 tracked bundle `plugins/kimi-delegate/mcp/server.mjs` 重新生成 | 通过 |
| `pnpm validate:plugin`（新 Node 校验器） | 通过；负向 fixture 确实失败 |

JSON 原始结果存于本机 `.worktrees/baseline-hardening/kimi-test-results.json`（gitignored，含环境信息，未提交）。

## 语义保留声明

- 启动/随机端口/鉴权/lifecycle 保护相关套件（startup、server-discovery、lifecycle、preflight、wait 等）本轮全部保持通过，未改动其语义。
- 未操作其他业务项目、凭据或系统服务；未恢复 AGY/Issue43 任务。
- 历史 spec/plan 文档（`docs/superpowers/`）中的 Python 校验命令为当时记录，未改写历史。

---

# 审查修订验收记录（第三轮）

日期：2026-11-05（同日第三轮）。来源：Codex 对第二轮交付的真实 diff 独立审查，5 项反馈逐条处理如下。

## 逐条处理

1. **路径比较不再 trim 空白**：`normalizeWorkspacePathForCompare` 去掉 `input.trim()`；`/repo` 与 `/repo `（POSIX 合法不同目录）不再被合并。补 Windows/POSIX 边界测试：POSIX 反斜杠作为文件名字符保留、POSIX 大小写敏感保留、两侧空白均不修剪。
2. **auto 数据目录标识与 URL 规范化分离**：`baseline-store.ts` 的 `normalizeServerUrl` 对 `auto:` 标识按字节精确比较（POSIX 大小写/空白敏感，Windows 标识已由 `automaticServerIdentity` 小写化）；http URL 只规范化 scheme/host，pathname 保留原样（避免合并大小写敏感路径服务端点）；常见根 URL（无 path）结果与旧整串小写规范化逐字节一致，升级后旧 baseline 仍可解析。新增真实 save/load 行为测试：`auto:/Case/Kimi Home` 与 `auto:/case/kimi home` 隔离、URL path 大小写隔离、auto 标识跨实例（模拟重启/端口变化）回读。
3. **原子写测试强化**：并发读取用例现在对每次读取单独断言（undefined 或完整有效 baseline，逐次验证）；替换用例先 warm 旧 baseline，再并发写入+并发读取，任何读取必须是旧值或新值之一（能抓住 delete-before-rename 变异）；新增真实跨进程用例（`process.execPath` + 仓库内 tsx 启动 `test/fixtures/baseline-store-worker.ts`，多写入者进程+进程内读者+读者进程同时竞争同一文件，逐次断言）；新增 `test/atomic-write.test.ts`，仅 mock `node:fs/promises` 的 rename/rm 边界（真实实现为默认），验证：持续 EPERM 时恰好重试 `ATOMIC_WRITE_MAX_ATTEMPTS` 次后抛出、旧文件完好、临时文件清理、非可重试错误快速失败、瞬态 EPERM 恢复后写入成功。`invalid file contents` 测试改为先真实 save 再覆写真实 hash 分区文件，断言无效数据被拒绝。
4. **插件校验落实 plugin-relative 契约**：`manifest.skills`/`manifest.mcpServers` 为绝对路径时直接拒绝（即使在 root 内）；skills 目录、mcp 配置、bundle 在读取前经 `realpathSync` 解析，防 symlink/junction 逃逸（lexical startsWith 之外再加真实路径包含检查）；version 正则锚定完整 semver，`0.3.0garbage` 被拒绝，`0.3.0+codex.<ts>` 仍接受。新增三个真实负向 fixture：绝对 skills 路径、junction/symlink 逃逸（Windows junction 与 POSIX symlink 通用）、非法 semver，全部确实失败。
5. **AGENTS.md 去除机器特定路径**：default workspace、Kimi Code 源码检出、marketplace 均改为 repo-relative 通用说明；作者署名与历史验证记录未动。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest（JSON reporter） | 353 通过 / 0 失败 / 0 跳过（21 个文件，含新增 atomic-write/paths/fixture 用例） |
| `pnpm test`（重建 bundle 后复跑） | 353/353 通过 |
| baseline+atomic 套件连续 5 次复跑 | 110/110 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build`，含 tracked bundle 重新生成 | 通过 |
| `pnpm validate:plugin` | 通过；6 个负向 fixture（缺 SKILL.md/内置 token/缺 bundle/绝对路径/symlink 逃逸/非法 semver）确实失败 |

父级将在 Ubuntu WSL（Node 22.23.4）独立测试；上述数字均为本机 Windows 实测。

---

# 验证器信任边界修订记录（第四轮）

日期：2026-11-05（同日第四轮）。来源：Codex 只读审查确认 `scripts/validate-plugin.mjs` 4 项 Important 缺陷。本轮只改验证器与其测试，runtime 源码无变更。

## 统一信任边界

验证器重构为两个集中守卫，覆盖每一个会被读取或认可的路径（manifest、skill 树、MCP 配置、server cwd、bundle）：

1. `guardPluginRelative`：必须为非空 plugin-relative 字符串，lexical 包含在插件根内；绝对路径直接拒绝（即使指回当前 checkout）。
2. `guardRealTarget`：`realpathSync` 解析真实目标必须在插件根 realpath 内（symlink/junction 逃逸拒绝），且文件类型匹配（文件/目录）。守卫失败一律记录 problem——坏链接不会被其他合法条目掩盖。

## 4 项缺陷修复

1. **JSON 解析错误泄漏输入**：`readJsonSecure` 不再转发 `JSON.parse(error.message)`（Node 新版错误会引用含 secret 的输入片段），只输出固定提示加字节位置。fixture：写入含 `SYNTH_9f8e7d6c_PLACEHOLDER` 的损坏 `.mcp.json`，实际运行校验器并断言 stdout 与 stderr 均不含该值、退出码非 0。
2. **manifest/skill 读取前无 realpath 守卫**：manifest 与 skill 树统一走 `guardRealTarget`；skill 树遍历时符号链接目录先解析守卫再决定是否深入，越界即硬失败。fixtures：`.codex-plugin` junction 指向根外 manifest（拒绝）；SKILL.md 根外链接（POSIX 真实文件 symlink；无特权 Windows 自动改用 junction 目录变体，两条路径都断言拒绝）；合法 skill 并存时树内 junction 逃逸仍失败。
3. **server.cwd 仅 lexical 检查**：cwd（若提供）必须为非空 plugin-relative 字符串，再做 lexical + realpath 目录校验；非法类型/空值给受控错误。fixtures：指向 root 内部的绝对 cwd 拒绝；非字符串 cwd（42）受控拒绝。
4. **version 正则误收/漏收**：采用完整 SemVer 2.0.0 规则（数字无前导零、prerelease/build 标识符非空且可共存）。fixtures 全部实际运行校验器：`1.2.3-rc.1+sha.abc` 通过（正向），`01.2.3`、`1.2.3-alpha..1`、`1.2.3-01`、`1.2`、`1.3.3-`、`0.3.0garbage` 拒绝（负向）；现有包 `0.3.0+codex.<timestamp>` 保持可用。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest（JSON reporter） | 365 通过 / 0 失败 / 0 跳过（20 个文件） |
| `pnpm test`（重建 bundle 后复跑） | 365/365 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build`，含 tracked bundle | 通过 |
| `pnpm validate:plugin` | 通过；validator 负向 fixture 累计 11 个（缺 SKILL.md/内置 token/缺 bundle/绝对 skills 路径/绝对 cwd/非字符串 cwd/manifest 逃逸/SKILL.md 逃逸/树内逃逸共存/非法 semver×7 参数化/JSON 泄漏）全部确实失败 |

runtime 路径与原子写修订（第二、三轮）本轮未改动；父级 Windows 与 Ubuntu WSL 独立测试反馈以父级后续报告为准。

---

# 验证器类型门禁修订记录（第五轮，最终）

日期：2026-11-05（同日第五轮）。来源：Codex 最后一组审查，确认前 4 项已修复后只剩 2 个类型门禁遗漏；runtime 源码已在父级 Windows/Ubuntu WSL 双双 353/353 通过，本轮只动验证器。

## 修复

1. **manifest 根类型**：合法 JSON 但根值为 `null`/`42`/`"manifest"`/`false`/`[]` 时旧代码直接 `return` 并打印 passed。现在登记固定失败 `root value must be a non-null, non-array JSON object`，随后以空对象继续必填字段校验，一次运行报告全部 schema 问题；修复过程不改变消息，不回显输入内容。
2. **server.env 类型**：`env` 若提供必须为非 null 非数组对象，所有值必须为 string；token 键的非空检查只在 string 值上进行（`KIMI_SERVER_TOKEN: 12345` 现在以 `env KIMI_SERVER_TOKEN must be a string` 受控拒绝）。类型/值失败消息固定，不回显数值或对象内容。
3. **同类分支一并扫清**（不扩展功能）：`mcp config` 根值类型门禁（非 null 非数组 object）、`mcpServers` 单个 server 条目类型门禁（拒绝 `null`/标量/数组条目并继续检查其余 server）。

## fixtures（全部真实运行校验器，无 skip）

- manifest 根类型矩阵：`null`、`42`、`"manifest"`、`false`、`[]` 均非零退出且 stderr 含根类型固定消息。
- env 类型矩阵：`42`、`"bad-env"`、`null`、`[]` 均以受控消息拒绝。
- env 值矩阵：`{KIMI_SERVER_TOKEN: 12345, OTHER_FLAG: {marker: SYNTH_c0ffee42_MARKER}}` 拒绝两个非 string 值，且 stdout/stderr 均不含 synthetic 标记或 `12345`。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest（JSON reporter） | 375 通过 / 0 失败 / 0 跳过（20 个文件） |
| `pnpm test`（重建 bundle 后复跑） | 375/375 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build`，含 tracked bundle | 通过 |
| `pnpm validate:plugin` | 通过；validator 既有全部负向 fixture（含前 4 轮的 11 类）保持确实失败 |

至此审查反馈全部处理完毕，停止实现，等待 Codex 验收。

---

# 测试兼容性修订记录（第六轮，最终）

日期：2026-11-05（同日第六轮）。来源：Codex 审查确认 manifest/env 两项已解决后仅剩 1 项 Important：`test/plugin.test.ts` 的 SKILL.md 逃逸 fixture 在 Windows 无 symlink 权限回退分支有两个文件系统错误——catch 内对已存在的 `skills/kimi-delegate` 目录创建 junction 会 EEXIST，`finally` 对普通目录非递归 `rmSync` 会 ERR_FS_EISDIR。本轮只改该测试兼容分支，runtime/验证器源码零改动。

## 修复

- 提取 test-only helper `createOutsideSkillEscape`（仅存在于测试文件）：文件 symlink 与 junction 两个底层操作可注入；回退分支改用未占用的 `skills/escaped-skill` 路径创建 junction，保留原 `skills/kimi-delegate` 目录与"根外 SKILL 必须拒绝"断言；`finally` 只删除实际创建的链接路径。
- 新增强制回归 `falls back to a real junction and still rejects the package when the file symlink is denied with EPERM`：注入的 `linkFile` 只抛出一次 EPERM，junction 回退走真实文件系统（Windows junction / POSIX 退化为真实目录 symlink），随后真实运行校验器断言拒绝。普通 Windows 与 POSIX 均可运行，无 skip、无需管理员/开发者模式。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| `pnpm test -- test/plugin.test.ts` | 35/35 通过 |
| 全量 Vitest（JSON reporter） | 376 通过 / 0 失败 / 0 跳过（20 个文件） |
| `pnpm test`（重建 bundle 后复跑） | 376/376 通过 |
| `pnpm typecheck`、`pnpm build`（含 tracked bundle）、`pnpm validate:plugin` | 全部通过 |

父级将在 Windows 与 Ubuntu WSL 重跑 376+ 结果独立验收。
