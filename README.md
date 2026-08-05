# Yan帳 · 处理环

个人工具：捕捉端投递原始记录 → 收件箱 → Codex/Claude 轻整理 → 日记为轴写回；本地联调使用临时文件 vault，生产环境使用独立的真实日记仓。

## 仓库绑定

- 工具仓：`https://github.com/L1248708823/koubo-diary.git`
- 日记仓：`https://github.com/L1248708823/Obsidian`

生产环境的 `VAULT_PATH` 必须指向服务器上日记仓的 clone 根目录。工具仓只提供程序、捕捉端静态资源、skill 和配置模板；`VAULT_REMOTE_URL` 用于启动前校验日记仓的 fetch/push remote，Git 事务锁使用 `GIT_LOCK_PATH`。

## 当前进度（本地可测）

| 切片 | 状态 |
|------|------|
| 01 处理编排 + 假 agent | 自动化测试全绿 |
| 02 收件 HTTP | 自动化测试全绿 |
| 03 投递唤醒编排 | 自动化测试全绿 |
| 04 捕捉端接真投递 | `capture/index.html`（B 手感 + 可配 URL/token） |
| 05 真 CLI agent 与研究 runner | Codex/Claude 内容 runner、独立 Codex research runner 与本地无 Git 联调线已就绪；真实来源质量仍需人工抽查 |
| 06 托底 / STATE / 演习 | 文档与 STATE 写入已就绪，生产 Git、凭证和 VPS 演习待现场确认 |

密钥、GitHub remote、CLI 登录等生产信息仍只放 VPS；本地可先用 `config/local.env.example` 建临时 vault 联调。代码仓与日记仓的 Git 生命周期由 `VAULT_GIT_MODE` 区分，生产 remote 模式必须配置 `VAULT_REMOTE_URL`。

## 开发与测试

```bash
npm install
npm test
npm run typecheck
```

环境变量模板：生产看 `config/production.env.example`，本地看 `config/local.env.example`。真实配置勿提交。

### 手机桌面安装

捕捉端生产构建包含 PWA manifest、service worker 和 Yan帳 SVG 图标：

```bash
npm run web:build
npm run web:preview -- --host 127.0.0.1 --port 4174
```

正式安装需要通过 HTTPS 访问部署后的捕捉端。Android Chrome 在菜单中选择安装应用或添加到主屏幕；iPhone 使用 Safari 的分享菜单选择添加到主屏幕。页面和 `ingestUrl` 都应使用 HTTPS，跨域部署时同时配置 CORS。局域网 HTTP 地址适合联调页面，不能作为正式 PWA 安装地址。

| 文档 | 用途 |
|------|------|
| `docs/ops/local-test.md` | 本地启动、自动测、页面半集成 |
| `npm run logs:clean` | 清理本地运行日志，不处理 vault 内容 |
| `docs/ops/local-test-cases.md` | 本地手工测试用例与执行记录 |
| `config/local.env.example` | 本地临时 vault 与真实 CLI 联调模板 |
| `config/production.env.example` | VPS 生产环境模板 |
| `docs/ops/handoff-ops.md` | 运营交接、两仓模型、上云顺序、缺口 |
| `docs/ops/vault-layout.md` | 真实 vault 日记树 / 想法 / 收件箱约定 |
| `docs/ops/field-drill.md` | VPS 演习清单 |

## 模块

- `src/processor/`：编排、机械验收、删 done、隔离、锁
- `src/ingest/`：Bearer 投递与本地/生产投递 adapter，只新建 `_inbox`
- `src/agent/`：Codex/Claude 非交互调用 adapter
- `src/research/`：研究任务、证据验收、研究简报和独立 Codex runner
- `src/git/`：日记 vault 工作区与生产 publisher；工具仓不会作为运行时 Git 目标
- `skills/处理收件箱/`：agent skill（轻整理边界 + 回执 schema）
- `skills/research-brief/`：研究证据、反方审查和简报写回契约
- `capture/`：B 在场感捕捉端，接真 Ingest
- `docs/ops/`：本地测 / 运营交接 / 演习

当前 runner 将处理边界内嵌到运行时 prompt，并禁止 agent 通过扫描或读取 `SKILL.md` 获取规则；skill 文件是维护和部署基线，不是线上 agent 的目录搜索入口。

## 领域词

见根目录 `CONTEXT.md`。硬决策见 `docs/adr/0001`–`0007`。
