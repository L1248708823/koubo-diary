# 本地启动与测试

面向开发机（Windows / macOS / Linux）。**不依赖**真 GitHub、真 Claude、真手机；要测「页面真的送进收件箱」时起两个进程即可。

## 0. 一次安装

```bash
cd /path/to/koubo-diary   # 本工具仓根目录
npm install
```

确认：

```bash
npm test
npm run typecheck
```

期望：测试全绿、`tsc` 无报错。这是日常默认门槛；改编排/收件契约后必跑。

## 1. 测试分层（先选对层）

| 层级 | 命令 / 动作 | 需要密钥？ | 验证什么 |
|------|-------------|------------|----------|
| A 契约自动测 | `npm test` | 否 | 编排验收、鉴权、唤醒、锁；临时 vault + 假 agent |
| B 本地半集成 | 起 ingest + 静态捕捉端 | 仅本地自拟 `INGEST_TOKEN` | 浏览器真 POST 进 `_inbox/` |
| C 假 agent 对真实目录 | 测试夹具或临时脚本 | 否（假 agent） | 指定 vault 路径上的删 inbox / 写日记语义 |
| D 真模型 | `CLAUDE_*` + `npm run processor` | 是 | skill 口气与回执 |
| E 上云演习 | 见 `field-drill.md` | 是 + VPS | 连倒 / 隔离 / 冲突 |

本地日常：**A 必跑**；接 UI 时加 **B**；密钥与 VPS 到位后再 D/E。

## 2. 层级 A：契约自动测（推荐默认）

```bash
npm test
npm run typecheck
```

行为说明：

- Vitest 在系统临时目录建 vault，测完删除
- `agentRunner` / `git` / 锁均可注入假实现
- **不会**监听端口、不会 push 远程、不会读你的 Obsidian 真库

失败时先看断言文案（例如「白名单外路径」「done 但缺 diary」），对照 `.scratch/processor-loop/spec.md` 的机械验收条款。

## 3. 层级 B：本地半集成（页面 → 收件箱）

### 3.1 准备一个「练习 vault」（不要用唯一生产库硬练）

```bash
# 示例路径，按你机器改
mkdir -p /tmp/koubo-practice-vault
cd /tmp/koubo-practice-vault
git init
git commit --allow-empty -m "init practice vault"
mkdir -p _inbox _inbox/_quarantine _staging _processor 日记 想法
```

Windows 可用 `D:/tmp/koubo-practice-vault` 等同路径。

### 3.2 写本工具仓的 `.env`（勿提交）

在本工具仓根目录：

```bash
cp .env.example .env
```

至少填写：

```env
INGEST_TOKEN=local-dev-only-change-me
VAULT_PATH=/tmp/koubo-practice-vault
INGEST_HOST=127.0.0.1
INGEST_PORT=8787
INGEST_PATH=/ingest
WAKE_MODE=file
WAKE_FLAG_PATH=/tmp/koubo-processor.wake
LOCK_PATH=/tmp/koubo-processor.lock
DIARY_DIR=日记
IDEAS_DIR=想法
```

说明：

- `INGEST_TOKEN` 随便长一点即可，仅本机
- 练习 vault 若没有 remote，`git push` 可能失败：当前 ingest 在 **commit 成功、push 失败** 时会返回 5xx 并可能保留本地文件。练 B 层时可以：
  - 给练习仓加一个「假 remote」（再开一个 bare 仓），或
  - 后续会话我们再加 `GIT_PUSH=0` 开发开关（当前未做则优先用 bare remote）

### 3.3 起收件服务

```bash
cd /path/to/koubo-diary
# 若需加载 .env，可用你习惯的方式 export，或：
# set -a && source .env && set +a   # bash
npm run ingest
```

期望日志类似：

```json
{ "ok": true, "listening": "http://127.0.0.1:8787/ingest", ... }
```

健康检查（另开终端）：

```bash
curl -s http://127.0.0.1:8787/health
```

### 3.4 起捕捉端静态页

**不要**用 `file://` 直接打开 HTML（跨域与安全策略易踩坑）。

```bash
cd /path/to/koubo-diary
npx --yes serve capture -p 4173
# 或: python -m http.server 4173 --directory capture
```

浏览器打开：`http://127.0.0.1:4173/`

### 3.5 在页面里配置并投递

1. 点 ⚙ 设置  
2. Ingest URL：`http://127.0.0.1:8787/ingest`  
3. Bearer：与 `.env` 的 `INGEST_TOKEN` 相同  
4. 保存（只进本机 localStorage，不进 git）  
5. 输入一段口播 →「送进收件箱」

期望：

- Toast「已投递」，输入框清空并回焦  
- `VAULT_PATH/_inbox/` 出现 `YYYYMMDD-HHMMSS-*.md`  
- 响应语义是 **delivered**，不是「已整理进日记」  
- `日记/` 不应被 ingest 创建正文

失败用例手测：

- 错 token → 正文保留 + 错误提示  
- 空内容 → 按钮禁用  
- 关停 ingest 再投 → 正文保留  

### 3.6 curl 代替浏览器（可选）

```bash
curl -sS -X POST http://127.0.0.1:8787/ingest \
  -H "Authorization: Bearer local-dev-only-change-me" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"curl 投递一条\",\"captured_at\":\"2026-07-29T20:00:00+08:00\"}"
```

### 3.7 CORS 注意

捕捉端端口（4173）与 ingest（8787）不同源。若浏览器控制台报 CORS，说明当前 Node 收件服务尚未放行跨域。临时解法：

- 用同域反代（推荐上云形态），或  
- 开发期给 ingest 加 Origin 白名单（实现期小改，见运营交接「已知缺口」）

手机访问本机 ingest 时，`INGEST_HOST=127.0.0.1` **不够**；需改为局域网 IP 并处理好防火墙与 CORS，或直接上 VPS HTTPS。

## 4. 层级 C / D 简述

- **C**：继续用 `npm test` 中的假 agent 契约；对「真实 vault 路径」干跑优先在拷贝库上做，避免污染生产日记。  
- **D**：配置 `CLAUDE_BIN` 或 `ANTHROPIC_API_KEY` 后 `npm run processor`；skill 在 `skills/处理收件箱/`。真模型结果人工抽查口气，不进默认 CI。

## 5. 常见失败

| 现象 | 可能原因 |
|------|----------|
| `npm run ingest` 报缺 `VAULT_PATH` | 未 export / 未 source `.env` |
| 401 unauthorized | token 与页面设置不一致 |
| 投递 5xx | vault 不是 git 仓、pull/push 失败、路径不可写 |
| 页面已投递但目录没有文件 | 看的不是同一个 `VAULT_PATH` |
| 测试绿但页面不通 | A 与 B 本就分层；按 §3 查进程与 URL |

## 6. 停服务

- 终端 `Ctrl+C` 结束 `ingest` 与 `serve`  
- 练习 vault 可整目录删除  
- 捕捉端设置在 localStorage，键前缀 `koubo-capture:`；可在页面「调试」里清本地列表
