# Agent 改工作树，脚本负责验收、删收件箱与 git

处理环需要模型做归类与轻整理，但不能让模型同时当仓库管理员。决定：VPS 上的 Codex 或 Claude CLI runner 按处理契约主写 vault 工作树（日记/想法/staging/STATE/回执），不得 commit/push，不得直接删除收件箱文件；独立的 Codex research runner 负责研究简报写回。编排脚本做路径白名单与回执交叉验收，通过后统一删除回执中 done 的收件箱条目，再 git add/commit/push。失败则收件箱留守并计次，超限进入隔离区。

## Considered Options

- 全脚本 + API 结构化（更稳，但未采用用户选择的 CLI 主路径）
- Agent 主写且自管 git（难验收、误 force push 面大）
- Agent 写树 + 脚本 git 与删收件箱（采纳）
