# Windows 本地 AI 联调

本地只验证两件事：

```text
浏览器投递 → Node 接收 → Codex/Claude 整理 → 临时 vault 写回
```

本地不使用 Git，不执行 `pull`、`commit`、`push`，也不创建 bare remote。真实 Obsidian 仓库的 Git 流程只在生产环境验证。

## 1. 安装依赖

在 Windows PowerShell 执行：

```powershell
Set-Location "D:\前端\需求开发文件夹\口播日记"
npm.cmd install
```

不要混用 Windows 和 WSL 的 `node_modules`。

## 2. Review 本地配置

```powershell
notepad .\config\local-codex.env
```

关键配置已经写好：

```env
VAULT_PATH=...\.temp-vaults\codex-e2e-local\vault
VAULT_GIT_MODE=local
INGEST_PORT=8788
CAPTURE_PORT=4173
AGENT_PROVIDER=codex
CODEX_BIN=codex.cmd
```

切换 Claude 只改：

```env
AGENT_PROVIDER=claude
CLAUDE_BIN=claude.cmd
```

## 3. 初始化临时 vault

```powershell
npm.cmd run local:setup
```

命令只会创建临时目录、目录结构、处理 skill 和本地前端 runtime config，不会初始化 Git，也不会连接任何远端。

## 4. 启动两个进程

窗口一：Node 接收服务。它在本地模式下会自动排队调用 processor，不需要再手动启动 `npm.cmd run local:processor`。

```powershell
Set-Location "D:\前端\需求开发文件夹\口播日记"
npm.cmd run local:ingest
```

窗口二：Vue 页面。

```powershell
Set-Location "D:\前端\需求开发文件夹\口播日记"
npm.cmd run local:web
```

浏览器打开：

```text
http://127.0.0.1:4173/
```

## 5. 验收

1. 页面输入一段口播，点击“送进收件箱”；
2. 页面立即得到 `delivered: true`；
3. Node 日志随后出现本地 processor 结果；
4. 临时 vault 中 `_inbox` 会先出现条目，处理成功后被清理；
5. 日记/想法和 `_processor/last-run.json` 写入临时 vault；
6. 失败时 inbox 保留，不会触碰真实 Obsidian vault。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8788/health
```

查看回执：

```powershell
$VaultPath = "D:\前端\需求开发文件夹\口播日记\.temp-vaults\codex-e2e-local\vault"
Get-Content -LiteralPath (Join-Path $VaultPath "_processor\last-run.json") -Raw |
  ConvertFrom-Json |
  ConvertTo-Json -Depth 10
```

## 6. 本地与生产的边界

| 项目 | 本地联调 | 生产环境 |
|------|----------|----------|
| `VAULT_PATH` | 临时 vault | 真实 Obsidian vault clone |
| `VAULT_GIT_MODE` | `local` | `remote` |
| Git pull/commit/push | 跳过 | 执行 |
| Codex/Claude | 可执行，用于验证 AI | 执行 |
| 回执、白名单、失败保留 | 保留 | 保留 |
| Git 冲突与远端失败 | 不测 | 线上 field drill 再测 |

生产配置示例：

```env
VAULT_PATH=/var/lib/koubo/vault
VAULT_GIT_MODE=remote
GIT_REMOTE=origin
VAULT_REMOTE_URL=https://github.com/L1248708823/Obsidian
GIT_LOCK_PATH=/run/koubo-git.lock
```

工具仓 `koubo-diary` 只负责部署 Node、前端、skill 基线和配置模板；`VAULT_PATH` 才是实际日记 Obsidian 仓库。当前 runner 通过运行时 prompt 注入处理规则，不要求 agent 读取 vault 内的 `SKILL.md`。两者不能混用。

生产前端构建：

```powershell
npm.cmd run web:build
```

生产服务使用真实 `.env` / systemd `EnvironmentFile`，不要使用 `config/local-codex.env`。

## 7. 常见问题

### `EADDRINUSE ... 8787`

本地配置已经使用 `8788`。检查并关闭旧进程：

```powershell
Get-NetTCPConnection -LocalPort 8788,4173 -ErrorAction SilentlyContinue
```

### 页面报 CORS

必须打开：

```text
http://127.0.0.1:4173/
```

不要改成 `localhost`。`INGEST_CORS_ORIGIN` 是精确白名单。

### 页面显示旧配置

```powershell
npm.cmd run local:setup
```

然后浏览器执行 `Ctrl+F5`。

### Codex 找不到

```powershell
Get-Command codex
Get-Command codex.cmd
```

把实际命令写入 `CODEX_BIN`。如果机器同时安装了 Volta、npm 全局 CLI 或多个 Codex，建议把 `CODEX_BIN` 写成 `Get-Command codex.cmd` 返回的绝对路径，避免子进程使用到错误的 PATH。
