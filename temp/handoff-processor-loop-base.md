# Handoff: 处理环基础开发已落地，等密钥上 VPS

日期：2026-07-29

## 你回来后给我什么

1. `INGEST_TOKEN`（长随机串，收件 Bearer）
2. VPS 上 vault clone 路径，或本机可写的测试 vault 路径
3. Claude 调用方式：`CLAUDE_BIN` 实际旗标，和/或 `ANTHROPIC_API_KEY`
4. 真实日记/想法目录名（若不是默认「日记/」「想法/」）
5. GitHub remote 是否已在 VPS vault 配好

**不要**把密钥贴进 git；用 `.env` 或口头/密码管理器给我，我只写进环境与 systemd。

## 已完成（本地可验）

```bash
cd "D:/前端/需求开发文件夹/口播日记"
npm test          # 18 passed
npm run typecheck # clean
```

- 01 编排全契约（假 agent）
- 02 收件 HTTP
- 03 投递唤醒贯通
- 04 `capture/index.html` 真投递 UI
- 05 skill + claude runner **骨架**
- 06 托底文档 + STATE 写入 + 演习模板

## 刻意没做

- 真 Claude 跑通与口气抽查
- 真 VPS systemd / 真 GitHub push
- 三场实机演习打勾

## 建议下一会话指令

> 密钥在 `.env` 了，请把 05/06 接到 VPS：先 dry-run 假 agent 对真 vault 目录，再开 Claude，最后按 `docs/ops/field-drill.md` 打演习勾。

## 关键路径

- 契约：`.scratch/processor-loop/spec.md` + issues
- 代码：`src/processor/` `src/ingest/` `src/agent/` `capture/`
- 运维：`docs/ops/field-drill.md` `.env.example`
