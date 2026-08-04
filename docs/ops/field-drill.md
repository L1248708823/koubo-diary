# 处理环运维与演习清单

密钥、VPS 登录、真 GitHub remote、选定 CLI 的登录/凭证到位后再跑本清单。本地 `npm test` 已覆盖假 agent 契约，不依赖这些秘密。
工具仓：`https://github.com/L1248708823/koubo-diary.git`；日记仓：`https://github.com/L1248708823/Obsidian`。生产 `VAULT_PATH` 必须指向日记仓 clone 根目录。

## 部署前

1. VPS 上 clone 工具仓与日记仓
2. 以 `config/production.env.example` 为模板，写入受限的 EnvironmentFile，填：
   - `INGEST_TOKEN`（长随机串）
   - `VAULT_PATH`（日记仓 clone 根目录）
   - `VAULT_GIT_MODE=remote`
   - `GIT_REMOTE=origin`
   - `VAULT_REMOTE_URL=https://github.com/L1248708823/Obsidian`
   - `AGENT_PROVIDER=codex` 或 `AGENT_PROVIDER=claude`
   - 对应 CLI：`CODEX_BIN` / `CLAUDE_BIN`，以及该 CLI 的本机登录或凭证
   - `LOCK_PATH`、`GIT_LOCK_PATH`、`WAKE_FLAG_PATH`（宿主机路径，**不进 git**）
3. 确认日记、想法和研究目录名与真实 vault 一致（`DIARY_DIR` / `IDEAS_DIR` / `RESEARCH_DIR`）
4. 捕捉端（`capture/index.html`）设置里填 Ingest URL 与同一 token（只存在设备 localStorage）
5. 启动处理环前确认仓库身份和根目录：
```bash
git -C /var/lib/koubo/vault rev-parse --show-toplevel
git -C /var/lib/koubo/vault remote get-url origin
git -C /var/lib/koubo/vault remote get-url --push origin
```
预期根目录是 `/var/lib/koubo/vault`，fetch 和 push remote 均归一化为 `github.com/l1248708823/obsidian`。

## 进程

- 收件：`npm run ingest`（或 systemd `koubo-ingest.service`）
- 处理：`npm run processor`（由 wake flag watcher / `systemctl start --no-block` / cron 触发）
- 托底 cron 建议：`*/15 * * * *` 调一次 processor；与唤醒重叠时靠文件锁串行

### 示例 cron

```cron
*/15 * * * * set -a; . /etc/koubo/koubo.env; set +a; cd /opt/koubo-diary && npm run processor >> /var/log/koubo-processor.log 2>&1
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
