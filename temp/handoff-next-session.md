# Handoff: 口播日记处理环 · 开新会话续作

日期：2026-07-30  
仓库：`D:\前端\需求开发文件夹\口播日记`  
Remote：`https://github.com/L1248708823/-koubo-diary.git`（private；仓名带前导 `-`）

## Goal for the next session

把 **05 真 Claude** 与 **06 托底/实机** 接到可用：先 push 未上云提交 → VPS 两仓就绪 → env → loopback 冒烟 → 真 skill → field-drill。  
日记/想法路径已按 ADR-0006 锁死，**不要重开 grill**。

## Suggested skills

1. **`/implement`** 或直接按 issues 05/06 做（密钥与 VPS 到位后）  
2. 读 domain：`CONTEXT.md` + `docs/adr/0001`–`0006`（尤其 **0006**）  
3. 需要时 **`/tdd`** 补路径/回执相关测  
4. 部署手测对照 **`docs/ops/local-test.md`**、**`docs/ops/handoff-ops.md`**、**`docs/ops/field-drill.md`**、**`docs/ops/vault-layout.md`**

## Where we are

### 已完成（本会话及之前）

| 项 | 状态 |
|----|------|
| 01 编排假 agent 全契约 | done，测试覆盖 |
| 02 收件 HTTP | done |
| 03 投递唤醒 | done |
| 04 捕捉端真投递 UI | `capture/index.html` |
| 05 skill + claude-runner **骨架** | 有；真跑等密钥 |
| 06 STATE/托底文档/演习模板 | 有；实机演习未做 |
| 运营/本地测文档 | `docs/ops/*` |
| 日记树 / 想法 grill → ADR-0006 | **已定稿落盘** |

`npm test`：**19 passed**；`npm run typecheck` 干净。

### Git（重要）

```
main...origin/main [ahead 1]
d054f12 docs: 锁定日记树写回与扁平想法（ADR-0006）  ← 未 push
8770597 docs: 补本地测试与运营交接文档
097fdd9 fix: 回执漏报…
9533199 feat: 处理环基础开发…
```

**下一会话第一件事：`git push origin main`**，否则 VPS clone 不到 ADR-0006。

### 硬决策（勿重议）

- 捕捉只写收件箱；处理端写正文（0001）  
- 处理只在 VPS；GitHub 仅 remote（0003）  
- Agent 写树，脚本验收/删 inbox/git（0004）  
- 日记为轴 + 可选想法（0005）  
- **日记路径**：`生活/日子一天天过去/YYYY/YYYY-MM/YYYY-MM-DD.md`  
- **想法**：顶层扁平 `想法/短标题.md`，一条一文件，v1 不归档  
- **双轴**：想法轴 / 待查轴，可组合，宁可少抽少标  
- **互链**：日记 = 钩子 + 链接；想法 = 全文 + 回链  
- 详见 `docs/adr/0006-diary-tree-flat-ideas-no-archive.md`、`docs/ops/vault-layout.md`

### 用户本机 vault

- 路径示例：`E:\日记`（**只许看目录结构，不要读笔记正文**）  
- 无默认 `_inbox` / `_processor` / 顶层 `想法` 时部署新建空目录  
- 日记树已存在于 `生活/日子一天天过去/`

## Do next（建议顺序）

1. `git push origin main`  
2. 用户侧：VPS clone **工具仓** + **vault 仓**；配 deploy key（vault 需 push）  
3. 按 `vault-layout.md` 建空目录；`.env`：  
   `DIARY_DIR=生活/日子一天天过去`、`IDEAS_DIR=想法`、`INGEST_TOKEN`、`VAULT_PATH`、Claude 凭证  
4. 本机或 VPS loopback：`npm run ingest` + 静态 `capture/`（见 `local-test.md`）  
5. 假 agent / 空跑确认写路径前缀正确  
6. 真 Claude：`skills/处理收件箱` + `src/agent/claude-runner.ts` 旗标对齐  
7. systemd/cron + `field-drill.md` 三场演习  
8. 已知缺口（可顺手修）：ingest CORS 或同域反代；systemd unit 落盘；时区 `Asia/Shanghai`

## Explicitly not done

- 真 Claude 口气抽查  
- 公网 HTTPS / 手机实投  
- field-drill 打勾  
- 捕捉端 Tailwind 重构（用户未要求优先）  
- 想法按年归档（明确 v1 不做）

## Secrets

用户将提供仓库与私钥等；**禁止写入 git**。优先 VPS/`EnvironmentFile` 路径。聊天勿粘贴完整 private key。

## Key paths

| 路径 | 用途 |
|------|------|
| `.scratch/processor-loop/spec.md` + `issues/` | 规格与票 |
| `src/processor/` `src/ingest/` | 编排与收件 |
| `skills/处理收件箱/SKILL.md` | 真 agent 口径（已含日记树） |
| `capture/index.html` | 捕捉端 |
| `docs/ops/handoff-ops.md` | 上云总册 |
| `temp/handoff-processor-loop-base.md` | 较早 handoff（本文件更新） |

## 给新会话的启动句（可复制）

> 读 `temp/handoff-next-session.md` 与 `docs/ops/handoff-ops.md`。先 `git push`，再按 vault-layout 与 env 接 VPS；日记树与想法规则以 ADR-0006 为准，不要重 grill。密钥在 `<path>`。
