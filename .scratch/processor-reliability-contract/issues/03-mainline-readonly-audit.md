# 03 — Yan帳 主线只读审计

**What to build:** 在前置契约完成后，对 Yan帳 主线进行一次只读审计，确认捕捉、收件、处理、日记、想法、研究、状态和发布之间没有新的偏离，并记录仍需人工决定的历史问题。

**Blocked by:** `yan-account-domain-contract/issues/01-processor-prompt-single-source.md`, `yan-account-domain-contract/issues/02-yan-account-user-copy.md`, `processor-reliability-contract/issues/01-processor-errors-visible.md`, `processor-reliability-contract/issues/02-research-writeback-closure.md`

**Status:** ready-for-agent

- [ ] 类型检查、全量自动化测试和前端构建结果被记录。
- [ ] 只读检查确认收件项所有权、日记路径、Yan帳 顶层扁平目录和研究状态契约。
- [ ] 真实测试 vault 的 STATE、研究任务、简报和双链状态被重新核对。
- [ ] 历史嵌套 Yan帳、旧简报、重复想法和死链接只被列为审计发现，不自动删除或迁移。
- [ ] 报告区分已修复问题、仍存在问题和需要使用者决定的业务边界。
- [ ] 审计不启动真实生产处理服务，不修改真实 vault 正文。
