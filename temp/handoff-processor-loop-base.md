# Handoff: 处理环基础开发已落地，等密钥与上云

日期：2026-07-30

## 运维文档（优先读）

| 文档 | 用途 |
|------|------|
| `docs/ops/local-test.md` | 本地怎么起、怎么测（自动测 / 半集成） |
| `docs/ops/handoff-ops.md` | 两仓模型、上云步骤、已知缺口、安全底线 |
| `docs/ops/field-drill.md` | VPS 实机演习勾选 |

## 你回来后给我什么

1. `INGEST_TOKEN`（长随机串，收件 Bearer）  
2. `VAULT_PATH`（VPS 上 vault clone）  
3. Claude：`CLAUDE_BIN` 旗标和/或 `ANTHROPIC_API_KEY`  
4. 真实日记/想法目录名与大致树  
5. 工具仓 / vault 仓 remote（private OK）与 VPS 是否已 clone  

**不要**把密钥提交进 git。优先 VPS 或本机文件路径。

## 已完成（本地可验）

```bash
npm test
npm run typecheck
```

- 01–04 行为与 UI 契约  
- 05 skill + runner 骨架  
- 06 STATE / 托底文档 / 演习模板  
- 运营与本地测试文档（本轮补齐）

## 刻意留给上云会话

- 真 Claude 口气抽查  
- systemd unit 落盘与公网 HTTPS  
- field-drill 三场打勾  

## 建议下一会话指令

> 两仓已 private 上 GitHub，VPS 已 clone；env 在 `<path>`；日记目录是……。请按 `docs/ops/handoff-ops.md` 冒烟后接 05/06。
