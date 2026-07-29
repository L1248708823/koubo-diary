# 处理端只在 VPS 运行，GitHub 仅作 remote

个人 vault 需要在 PC 关机时仍能消化收件箱，且必须与 Obsidian Git 避免双写者。决定：投递网关与处理环唯一宿主为已有云 VPS（投递唤醒 + cron）；GitHub 只作 git remote 保存历史与多端 pull。v1 不使用 GitHub Actions 跑整理或写正文。

## Considered Options

- 仅 PC 常驻（周末停摆）
- VPS 唯一处理端（采纳）
- GitHub Actions 为主或与 VPS 双跑（双写与冷启动代价高，个人工具过重）
