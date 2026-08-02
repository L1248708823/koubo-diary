# 口播日记 · 处理环

个人工具：捕捉端投递口播 → 收件箱 → Codex/Claude 轻整理 → 日记为轴写回；本地联调使用临时文件 vault，生产环境再同步真实日记仓。

## 当前进度（本地可测）

| 切片 | 状态 |
|------|------|
| 01 处理编排 + 假 agent | 自动化测试全绿 |
| 02 收件 HTTP | 自动化测试全绿 |
| 03 投递唤醒编排 | 自动化测试全绿 |
| 04 捕捉端接真投递 | `capture/index.html`（B 手感 + 可配 URL/token） |
| 05 真 CLI agent 与研究 runner | Codex/Claude 内容 runner、独立 Codex research runner 与本地无 Git 联调线已就绪，真实 CLI 研究样例待人工抽查 |
| 06 托底 / STATE / 演习 | 文档与 STATE 写入已就绪，**实机演习等 VPS** |

密钥、GitHub remote、CLI 登录等生产信息仍只放 VPS；本地可先用 `config/local.env.example` 建临时 vault 联调。代码仓与日记仓的 Git 生命周期由 `VAULT_GIT_MODE` 区分。

## 开发与测试

```bash
npm install
npm test
npm run typecheck
```

环境变量模板：生产看 `config/production.env.example`，本地看 `config/local.env.example`。真实配置勿提交。

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

## 领域词

见根目录 `CONTEXT.md`。硬决策见 `docs/adr/0001`–`0005`。
