# 运营交接：从本机到 VPS

日期：2026-07-30  
读者：未来的你 / 下一会话的 agent  
前置：处理环 01–04 已本地落地；05/06 待密钥与真机。

相关文档：

- 本地怎么测：`docs/ops/local-test.md`
- 上云后演习勾选：`docs/ops/field-drill.md`
- 环境变量模板：`.env.example`
- 架构硬决策：`docs/adr/0001`–`0005`
- 规格：`.scratch/processor-loop/spec.md`

---

## 1. 系统里有几块东西

请始终当成 **两个 git 仓库 + 一台 VPS 进程面**，不要混成一个仓。

```text
┌─────────────────────┐     HTTPS+Bearer      ┌──────────────────────────────┐
│ 捕捉端（静态页）      │ ───────────────────▶ │ VPS                          │
│ capture/index.html  │   POST /ingest        │  koubo-ingest（Node）         │
└─────────────────────┘                       │  koubo-processor（cron/唤醒） │
                                              │  Claude（可选，真整理）         │
                                              │  vault clone（权威写者）       │
                                              └──────────────┬───────────────┘
                                                             │ git push
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │ GitHub private：vault 仓      │
                                              └──────────────┬───────────────┘
                                                             │ pull
                                              ┌──────────────▼───────────────┐
                                              │ PC Obsidian Git               │
                                              └──────────────────────────────┘

另：本工具代码仓（koubo-diary）也建议 private 上 GitHub，供 VPS git pull 部署。
```

| 资产 | 是什么 | 是否进 git | 谁写 |
|------|--------|------------|------|
| 工具仓 | Node 编排 + 捕捉端静态页 + skill | 是（无密钥） | 开发机 / CI |
| vault 仓 | Obsidian 正文、`_inbox`、`_processor` | 是（无 token） | **仅 VPS 处理环写正文**；捕捉只经 ingest 新建 inbox |
| `INGEST_TOKEN` | 手机投递共享密钥 | **否** | 只在 VPS env + 手机 localStorage |
| Claude / API 凭证 | 模型调用 | **否** | 只在 VPS |
| git deploy key / PAT | clone/push private 仓 | **否** | 只在 VPS `~/.ssh` 或 credential |
| 文件锁 / wake flag | `/run/koubo-*.lock` 等 | **否** | 宿主机本地 |

---

## 2. 你计划做的三步（核对清单）

### 步骤 1：在 GitHub 建仓，工具也上 GitHub

建议建 **两个 private 仓库**（名字可自定）：

1. `koubo-diary`（或 `口播日记-工具`）→ 本工具代码  
2. `obsidian-vault`（或你现有日记仓）→ 真正的笔记库  

本机推送工具仓示例：

```bash
cd /path/to/koubo-diary
git remote add origin git@github.com:<you>/koubo-diary.git
git push -u origin main
```

**注意：**

- 推之前确认没有 `.env`、私钥、vault 全文误加进工具仓（见 `.gitignore`）
- 若 GitHub 上已用网页建了带 README 的仓，先 `git pull --rebase origin main` 再 push，或按「以本地为准」强制策略（私人空仓更省事）
- vault 仓若已存在，**不要**把 vault 历史硬塞进工具仓；保持两仓分离
- 工具仓 private 完全 OK；VPS 用 deploy key 拉代码

### 步骤 2：把日记大概目录给我

请尽量提供「树状示意 + 真实目录名」，例如：

```text
vault 根/
  日记/           # 或 Daily notes / Journal …
  想法/           # 或 灵感/ …
  _inbox/         # 若还没有，部署时创建
  其它文件夹/     # 处理环不应改
```

我会用来：

- 改 `.env` 的 `DIARY_DIR` / `IDEAS_DIR`（及文档示例）
- 核对 skill 文案里的路径说法
- **非必需**微调提示词；没有目录也能靠配置跑，有则少踩「写错文件夹」

请同时说明：日记文件名习惯（`YYYY-MM-DD.md`？）、是否已有 `_inbox`。

### 步骤 3：12 点之后在服务器下载这两个仓库

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
3. 工具仓 `npm ci --omit=dev` 或 `npm ci`（若要用 `tsx` 跑源码，devDependency 也要）  
4. 写 env，**先**用假路径或练习 vault 做 `curl` 投递，再指到真 vault  
5. 再装 systemd / cron / Caddy  

**12 点后下载本身没问题**；有问题的是「下载完是否立刻指到真 vault 并暴露公网」。我建议：先 clone + 装依赖 + 本地 loopback 冒烟，再开 HTTPS 与真 token。

---

## 3. 上云最小路径（密钥到位后）

1. VPS：Node ≥20、git、时区建议 `Asia/Shanghai`  
2. Clone 工具仓 + vault 仓  
3. vault 布局见 `docs/ops/vault-layout.md`：建 `_inbox/`、隔离区、`_staging/`、`_processor/`、`想法/`；日记写既有树 `生活/日子一天天过去/`（勿另起平行口播日记区）  
4. 环境变量（`EnvironmentFile=` 或 `/opt/koubo-diary/.env`）：  
   - `INGEST_TOKEN`（长随机）  
   - `VAULT_PATH`  
   - `DIARY_DIR=生活/日子一天天过去`、`IDEAS_DIR=想法`  
   - `CLAUDE_BIN` 或 `ANTHROPIC_API_KEY`  
   - `LOCK_PATH` / `WAKE_FLAG_PATH`  
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
| 真 Claude CLI 旗标未在你机器钉死 | `claude-runner` 可能要改参数 | 05 真跑时调 |
| skill 安装位置 | Claude Code 是否读仓库内 `skills/` | 真跑时验证或拷到约定目录 |
| push 失败时客户端重试可能重复 inbox | 不同 id 两条 | 知悉即可；日后可做幂等 |
| 捕捉端「今日已投」仅本机 | 换机计数不准 | 产品接受 |
| 短时撤销不删服务端 | 误触多一条 inbox | 产品接受 |
| 失败路径 attempts 的 commit 为尽力而为 | 极端 git 失败可能丢计数 | 演习 B 观察 |
| 工具仓尚无（或新建）remote | 你即将建仓 | 建完 `git remote add` |

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

> 已建 private 工具仓与 vault 仓；VPS 上两仓已 clone；env 在 `<path>`。请读 `docs/ops/local-test.md` 与本文件，先 loopback 冒烟，再接真 Claude，最后按 `field-drill.md` 演习。日记目录实名：……

---

## 7. 当前代码状态（写文档时）

- 提交：`097fdd9` 及之前的基础开发  
- `npm test` 应全绿；以你机器最新运行为准  
- 捕捉端：`capture/index.html`  
- 收件 / 编排：`src/ingest`、`src/processor`
