# 处理环运维与演习清单

密钥、VPS 登录、真 GitHub remote、选定 CLI 的登录/凭证到位后再跑本清单。本地 `npm test` 已覆盖假 agent 契约，不依赖这些秘密。

## 部署前

1. VPS 上 clone 本仓库与 vault remote
2. 复制 `.env.example` → `.env`（或 systemd `EnvironmentFile`），填：
   - `INGEST_TOKEN`（长随机串）
   - `VAULT_PATH`
   - `AGENT_PROVIDER=codex` 或 `AGENT_PROVIDER=claude`
   - 对应 CLI：`CODEX_BIN` / `CLAUDE_BIN`，以及该 CLI 的本机登录或凭证
   - `LOCK_PATH`、`WAKE_FLAG_PATH`（宿主机路径，**不进 git**）
3. 确认日记、想法和研究目录名与真实 vault 一致（`DIARY_DIR` / `IDEAS_DIR` / `RESEARCH_DIR`）
4. 捕捉端（`capture/index.html`）设置里填 Ingest URL 与同一 token（只存在设备 localStorage）

## 进程

- 收件：`npm run ingest`（或 systemd `koubo-ingest.service`）
- 处理：`npm run processor`（由 wake flag watcher / `systemctl start --no-block` / cron 触发）
- 托底 cron 建议：`*/15 * * * *` 调一次 processor；与唤醒重叠时靠文件锁串行

### 示例 cron

```cron
*/15 * * * * cd /opt/koubo-diary && . ./.env && npm run processor >> /var/log/koubo-processor.log 2>&1
```

### 示例唤醒

ingest 的 `onWake` 默认 `touch` `WAKE_FLAG_PATH`。可用 path unit 或短脚本：

```bash
# 伪代码：flag 出现则 start processor 并清 flag
if [ -f /run/koubo-processor.wake ]; then
  rm -f /run/koubo-processor.wake
  systemctl start koubo-processor.service --no-block
fi
```

## 演习记录模板

把每次实机结果追加到本文件底部或 vault 的 `_processor/loop-run-log.md`。

### 演习 A：连续多条投递

- [ ] 捕捉端连倒 ≥3 条，皆 `delivered: true`
- [ ] 唤醒或托底后日记出现对应轻整理段落
- [ ] 成功项 inbox 被脚本删除；隔离区无误伤
- [ ] PC `git pull` 后 Obsidian 可见

日期 / 操作者 / 结果：

```
（回来后填写）
```

### 演习 B：故意失败进隔离

- [ ] 构造无法验收的回执或损坏 diary 声明
- [ ] attempts 递增；≥3 后进入 `_inbox/_quarantine/`
- [ ] 原文仍在隔离区；普通待处理列表不再包含

日期 / 结果：

```
（回来后填写）
```

### 演习 C：git 冲突中止

- [ ] 模拟 pull/push 冲突（或真在 PC 改同日日记制造冲突）
- [ ] 本轮 `conflict`/`failed`，inbox 留守
- [ ] STATE 可读到原因

日期 / 结果：

```
（回来后填写）
```

## STATE 阅读

`_processor/STATE.md` 进 vault，字段含 `updated_at` / `status` / `detail`。  
`last-run.json` 是最近一轮 AI 回执，脚本已交叉验证。
