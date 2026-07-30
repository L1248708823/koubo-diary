# 口播日记 · 处理环

个人工具：捕捉端投递口播 → VPS 收件箱 → 处理编排（Claude 轻整理）→ 日记为轴写回 → git 同步到 Obsidian。

## 当前进度（本地可测）

| 切片 | 状态 |
|------|------|
| 01 处理编排 + 假 agent | 自动化测试全绿 |
| 02 收件 HTTP | 自动化测试全绿 |
| 03 投递唤醒编排 | 自动化测试全绿 |
| 04 捕捉端接真投递 | `capture/index.html`（B 手感 + 可配 URL/token） |
| 05 真 Claude skill | skill 与 runner 骨架已就绪，**等密钥** |
| 06 托底 / STATE / 演习 | 文档与 STATE 写入已就绪，**实机演习等 VPS** |

密钥、GitHub remote、Claude 登录等你回来再填；在此之前请用 `npm test` 锁契约。

## 开发与测试

```bash
npm install
npm test
npm run typecheck
```

环境变量见 `.env.example`（复制为 `.env`，勿提交）。

| 文档 | 用途 |
|------|------|
| `docs/ops/local-test.md` | 本地启动、自动测、页面半集成 |
| `docs/ops/handoff-ops.md` | 运营交接、两仓模型、上云顺序、缺口 |
| `docs/ops/field-drill.md` | VPS 演习清单 |

## 模块

- `src/processor/`：编排、机械验收、删 done、隔离、锁
- `src/ingest/`：Bearer 投递，只新建 `_inbox`
- `src/agent/claude-runner.ts`：真 Claude 非交互调用骨架
- `skills/处理收件箱/`：agent skill（轻整理边界 + 回执 schema）
- `capture/`：B 在场感捕捉端，接真 Ingest
- `docs/ops/`：本地测 / 运营交接 / 演习

## 领域词

见根目录 `CONTEXT.md`。硬决策见 `docs/adr/0001`–`0005`。
