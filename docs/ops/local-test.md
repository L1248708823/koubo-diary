# 本地联调与生产执行线

当前实现明确分成两条执行线。两条线共用收件校验、AI runner、skill、回执验收、白名单、失败计次和隔离区规则，vault 的工作区访问方式与发布动作分开。

## 先做自动检查

Windows PowerShell 建议使用 `npm.cmd`，避免本机执行策略拦截 `npm.ps1`：

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run web:build
```

这组检查不需要真实 vault、Git remote 或 Codex 登录。

## 本地联调线

本地线使用临时 vault 文件夹，`VAULT_GIT_MODE=local`。本地代码只做文件快照和文件写入，处理编排不接收 publisher，收件投递也不调用 pull、add、commit 或 push。

```text
捕捉端
  → 本地 ingest
  → 临时 vault/_inbox
  → 同一 Node 进程排队运行 processor
  → Codex 或 Claude 修改临时 vault
  → 回执与白名单验收
  → 成功删除临时 vault/_inbox 条目
```

本地配置文件分两份：

```powershell
Copy-Item .\config\local.env.example .\config\local-codex.env
notepad .\config\local-codex.env
```

至少修改 `VAULT_PATH` 和 `LOCK_PATH`，这两个路径应指向工具仓之外的临时目录。Windows 本地配置可以写成：

```env
VAULT_PATH=D:/path/to/koubo-diary/.temp-vaults/local/vault
LOCK_PATH=D:/path/to/koubo-diary/.temp-vaults/local/processor.lock
VAULT_GIT_MODE=local
AGENT_PROVIDER=codex
CODEX_BIN=codex.cmd
```

初始化和启动：

```powershell
npm.cmd run local:setup
```

窗口一：

```powershell
npm.cmd run local:ingest
```

窗口二：

```powershell
npm.cmd run local:web
```

浏览器打开 `http://127.0.0.1:4173/`，投递地址是 `http://127.0.0.1:8788/ingest`。本地 ingest 投递成功后会自动排队调用 processor，不需要再启动 `local:processor`。

## 本地日志

本地配置中的 `LOG_AGENT_OUTPUT=1` 会把 Codex/Claude 的标准输出和错误输出实时打印到 `local:ingest` 或 `local:processor` 终端。重点关注这些事件：

```text
ingest.delivered          已写入 inbox
processor.queue_enqueued  已进入本地处理队列
lock.acquired             已拿到处理锁
processor.inbox_scanned   扫描到多少条 inbox
agent.started             已启动 Codex/Claude，包含 bin 和工作目录
agent.output              CLI 的实时输出
agent.exited              CLI 退出码和耗时
processor.acceptance      回执验收结果
processor.round_finished  本轮完成
```

如果手动运行 `local:processor` 返回 `status: locked`，先查看 `local:ingest` 窗口里的 `lock.busy` 日志。日志会包含锁文件中的 PID 和创建时间。确认持有锁的处理进程已经退出后，才清理陈旧的 `processor.lock`。

验收重点：

1. 页面返回 `delivered: true`，这个结果只表示进入收件箱。
2. 临时 vault 的 `_inbox` 出现文件，随后由处理编排按验收结果清理。
3. 日记、想法和 `_processor/last-run.json` 只出现在临时 vault。
4. 工具仓 `git status` 不应因为本次联调产生 vault 正文改动。
5. 本地进程日志中不应出现 Git pull、commit、push。

切换 Claude 只修改本地配置：

```env
AGENT_PROVIDER=claude
CLAUDE_BIN=claude.cmd
```

## 生产执行线

生产线由 VPS 的工具仓进程和日记 vault 仓组成。`VAULT_PATH` 是唯一的 Git 工作目录。

```text
工具仓 /opt/koubo-diary
  只提供 Node、捕捉端静态资源和 skill

日记仓 /var/lib/koubo/vault
  ingest：pull → 新建 _inbox → add/commit/push
  processor：pull → agent 写工作树 → 回执验收 → 脚本删 inbox → add/commit/push
```

生产配置以 `config/production.env.example` 为模板，实际配置放 VPS 的权限受限 EnvironmentFile：

```env
VAULT_PATH=/var/lib/koubo/vault
VAULT_GIT_MODE=remote
GIT_REMOTE=origin
```

生产进程从工具仓启动不会改变 Git 目标。代码通过 `VAULT_PATH` 创建 vault workspace 和 publisher，工具仓路径只用于找到 Node 程序与 skill。

生产线才验证以下行为：

- 日记仓 pull、commit、push。
- 日记仓远端冲突时停止本轮并保留收件箱。
- 生产 vault 的部署 key 和 remote 权限。
- 唤醒文件、cron、systemd 单实例锁。

本地线无法证明这些生产行为，所以它只负责联调文件写回和真实 CLI runner。生产前的手测顺序见 `docs/ops/field-drill.md` 与 `docs/ops/handoff-ops.md`。

## 两个仓库的判定规则

| 位置 | 用途 | 允许的 Git 操作 |
|------|------|----------------|
| 工具仓当前目录 | Node、捕捉端、skill、文档 | 开发者提交工具代码 |
| `VAULT_PATH` | Obsidian 日记正文、收件箱、处理状态 | 生产 ingest 和 processor 发布 |
| 本地临时 vault | 本机联调现场 | 不初始化 Git，不执行 Git |

如果需要确认当前进程配置指向哪里，先检查：

```powershell
$env:VAULT_PATH
git -C $env:VAULT_PATH rev-parse --show-toplevel
```

第二条只应在 `VAULT_GIT_MODE=remote` 的生产配置下执行。工具仓路径不能填入 `VAULT_PATH`，本地配置也不应指向真实 Obsidian vault。
