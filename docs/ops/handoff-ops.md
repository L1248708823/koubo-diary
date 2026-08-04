# 运营交接：从本机到 VPS

日期：2026-08-04  
读者：VPS 部署与运维人员  
前置：自动化检查、本地 Codex/Claude runner 和研究 runner 已落地；生产 Git、凭证与现场演习仍需按清单确认。

相关文档：

- 本地怎么测：`docs/ops/local-test.md`
- 上云后演习勾选：`docs/ops/field-drill.md`
- 环境变量模板：`config/production.env.example`
- 架构硬决策：`docs/adr/0001`–`0007`
- 规格：`.scratch/processor-loop/spec.md`

---

## 1. 系统里有几块东西

请始终当成 **两个 git 仓库 + 一台 VPS 进程面**，不要混成一个仓。

```text
┌─────────────────────┐     HTTPS+Bearer      ┌──────────────────────────────┐
│ 捕捉端（静态页）      │ ───────────────────▶ │ VPS                          │
│ capture/index.html  │   POST /ingest        │  koubo-ingest（Node）         │
└─────────────────────┘                       │  koubo-processor（cron/唤醒） │
                                              │  Codex 或 Claude CLI runner      │
                                              │  vault clone（权威写者）       │
                                              └──────────────┬───────────────┘
                                                             │ git push
                                                             ▼
                                              ┌──────────────────────────────┐
                                               │ GitHub：Obsidian 日记仓        │
                                              └──────────────┬───────────────┘
                                                             │ pull
                                              ┌──────────────▼───────────────┐
                                              │ PC Obsidian Git               │
                                              └──────────────────────────────┘

工具仓：`https://github.com/L1248708823/koubo-diary.git`；日记仓：`https://github.com/L1248708823/Obsidian`。两仓必须保持分离。
```

| 资产 | 是什么 | 是否进 git | 谁写 |
|------|--------|------------|------|
| 工具仓 | Node 编排 + 捕捉端静态页 + skill | 是（无密钥） | 开发机 / CI |
| vault 仓 | Obsidian 正文、`_inbox`、`_processor` | 是（无 token） | **仅 VPS 处理环写正文**；捕捉只经 ingest 新建 inbox |
| `INGEST_TOKEN` | 手机投递共享密钥 | **否** | 只在 VPS env + 手机 localStorage |
| Codex / Claude CLI 凭证 | 模型调用 | **否** | 只在 VPS |
| git deploy key / PAT | clone/push private 仓 | **否** | 只在 VPS `~/.ssh` 或 credential |
| 文件锁 / wake flag | `/run/koubo-*.lock` 等 | **否** | 宿主机本地 |

---

## 2. 已绑定仓库与目录约定

### 已绑定的两个仓库

当前已确定使用两个 private 仓库：

1. `https://github.com/L1248708823/koubo-diary.git` → 工具代码  
2. `https://github.com/L1248708823/Obsidian` → 真实日记 vault  

VPS 或开发机拉取工具仓和日记仓时使用对应的 GitHub 凭证：

```bash
git clone https://github.com/L1248708823/koubo-diary.git /opt/koubo-diary
git clone https://github.com/L1248708823/Obsidian /var/lib/koubo/vault
```

**注意：**

- 推之前确认没有 `.env`、私钥、vault 全文误加进工具仓（见 `.gitignore`）
- 工具仓和日记仓都不要互相嵌套；`VAULT_PATH` 只能指向日记仓 clone 根目录
- vault 仓若已存在，**不要**把 vault 历史硬塞进工具仓；保持两仓分离
- 工具仓 private 完全 OK；VPS 用 deploy key 拉代码

### 日记目录约定（当前默认）

生产默认目录如下；如果真实 vault 已有不同目录，只通过环境变量调整，不迁移历史正文：

```text
vault 根/
  生活/日子一天天过去/  # 日记前缀
    YYYY/YYYY-MM/YYYY-MM-DD.md
  Yan帳/想法/     # 工具维护的长期想法区
  Yan帳/研究/     # 研究简报区
  _inbox/         # 若还没有，部署时创建
  其它文件夹/           # 处理环不应改
```

对应配置为 `DIARY_DIR=生活/日子一天天过去`、`IDEAS_DIR=Yan帳/想法`、`RESEARCH_DIR=Yan帳/研究`。部署时创建 `_inbox/`、`_processor/`、`_staging/` 和 `_inbox/_quarantine/`。当前 runner 的边界由运行时 prompt 提供，agent 不应扫描或读取 vault 内的 `SKILL.md`。

### VPS 部署布局与顺序

合理，且符合「VPS 唯一处理宿主」。建议服务器上的布局：

```text
/opt/koubo-diary/          # 工具仓
/var/lib/koubo/vault/      # vault 仓 clone（VAULT_PATH）
/etc/koubo/koubo.env       # 权限 600 的环境文件（可选）
/run/koubo-processor.lock  # 不进 git
/run/koubo-processor.wake
```

顺序建议：

1. 先配 **SSH deploy key**（工具仓只读即可；vault 仓要能 **push**）  
2. `git clone` 两仓  
3. 工具仓执行 `npm ci`，当前生产脚本直接使用 devDependency 中的 `tsx` 运行源码  
4. 写 env，**先**用假路径或练习 vault 做 `curl` 投递，再指到真 vault  
5. 再装 systemd / cron / Caddy  

**12 点后下载本身没问题**；有问题的是「下载完是否立刻指到真 vault 并暴露公网」。我建议：先 clone + 装依赖 + 本地 loopback 冒烟，再开 HTTPS 与真 token。

---

## 3. 上云最小路径（密钥到位后）

1. VPS：Node ≥20、git、时区建议 `Asia/Shanghai`  
2. Clone 工具仓 + vault 仓  
3. vault 布局见 `docs/ops/vault-layout.md`：建 `_inbox/`、隔离区、`_staging/`、`_processor/`、`Yan帳/想法/`、`Yan帳/研究/`；`.claude/skills/处理收件箱/SKILL.md` 可作为维护基线，但当前 runner 通过运行时 prompt 注入规则，agent 不应读取或扫描该文件；日记写既有树 `生活/日子一天天过去/`（勿另起平行目录）
4. 环境变量（`EnvironmentFile=` 或 `/opt/koubo-diary/.env`）：  
   - `INGEST_TOKEN`（长随机）  
   - `VAULT_PATH`  
   - `VAULT_GIT_MODE=remote`（生产指向真实 Obsidian vault 仓库，不是工具仓）
   - `GIT_REMOTE=origin`
   - `VAULT_REMOTE_URL=https://github.com/L1248708823/Obsidian`（用于启动时校验日记仓身份）
   - `DIARY_DIR=生活/日子一天天过去`、`IDEAS_DIR=Yan帳/想法`、`RESEARCH_DIR=Yan帳/研究`
   - `AGENT_PROVIDER=codex` 或 `AGENT_PROVIDER=claude`  
   - 对应 CLI 的 `CODEX_BIN` / `CLAUDE_BIN`，以及该 CLI 的本机登录或凭证  
   - `LOCK_PATH` / `GIT_LOCK_PATH` / `WAKE_FLAG_PATH`
5. systemd  
   - `koubo-ingest.service`：常驻 `npm run ingest`（或 `npx tsx src/cli/run-ingest.ts`）  
   - `koubo-processor.service`：oneshot `npm run processor`  
   - cron：`*/15 * * * *` 触发 processor  
   - 可选：watch `WAKE_FLAG_PATH` 后 `systemctl start koubo-processor --no-block`  
6. Caddy/Nginx：  
   - `https://domain/ingest` → `127.0.0.1:8787`  
   - `https://domain/` → `capture/` 静态文件  
   - **同域**可避开 CORS 开发坑  
7. 手机打开 `https://domain/`，设置里填同域 ingest URL + token  
8. 按 `field-drill.md` 打演习 A/B/C  

密钥传递方式（优先序）：

1. 你只写在 VPS 的 root-only 文件，告诉我路径  
2. 本机 `.env` 不进 git，会话里让我读路径  
3. 避免把 private key 整段贴进聊天记录  

---

## 4. 已知缺口（交接时别假装没有）

| 缺口 | 影响 | 建议时机 |
|------|------|----------|
| Ingest 默认几乎无 CORS | 跨端口本地页可能被浏览器拦 | 上云同域 或 开发期加 Origin 白名单 |
| 无现成 systemd unit 文件进仓 | 上云要手写 unit | 部署会话补进 `docs/ops/systemd/` |
| Codex / Claude CLI 旗标未在目标机器钉死 | 对应 adapter 可能要改参数 | 05 真跑时调 |
| skill 文件 | 作为工具仓维护和部署基线；当前 runner 不要求 agent 读取 | 更新 skill 后同步检查运行时 prompt 与测试 |
| push 失败时客户端重试可能重复 inbox | 不同 id 两条 | 知悉即可；日后可做幂等 |
| 捕捉端「今日已投」仅本机 | 换机计数不准 | 产品接受 |
| 短时撤销不删服务端 | 误触多一条 inbox | 产品接受 |
| 失败路径 attempts 的 commit 为尽力而为 | 极端 git 失败可能丢计数 | 演习 B 观察 |
| 生产 remote 预检尚未在真实 VPS 演习 | 未验证真实 clone、fetch/push 权限和路径 | 按 `field-drill.md` 的部署前检查执行 |

---

## 5. 安全底线（私人仓库也不例外）

- private 仓 ≠ 可以提交 token  
- vault 与工具仓的 deploy key **分开**  
- 公网只走 HTTPS；ingest 不要裸 HTTP 长期挂着  
- 怀疑手机 token 泄露：轮换 `INGEST_TOKEN`，旧 token 立即失效  
- 禁止 force push；agent 禁止 `git commit`（脚本统一提交）  
- 白名单外路径变更 → 整轮失败（已测）

---

## 6. 给下一会话 agent 的启动句

> 工具仓是 `https://github.com/L1248708823/koubo-diary.git`，日记仓是 `https://github.com/L1248708823/Obsidian`。请先读取 `config/production.env.example`、`docs/ops/local-test.md` 和本文件，在 VPS 上确认 `VAULT_PATH` 是日记仓根目录、`VAULT_REMOTE_URL` 与 fetch/push remote 匹配，再按 `field-drill.md` 演习。

---

## 7. 当前代码状态（写文档时）

- 代码与文档以当前分支最新提交为准，不使用历史提交号判断生产状态  
- 最新自动化基线：18 个测试文件、121 条测试通过；`npm.cmd run typecheck` 通过  
- 捕捉端：`capture/index.html`  
- 收件 / 编排：`src/ingest`、`src/processor`
