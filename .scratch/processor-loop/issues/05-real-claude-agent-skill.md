# 05 — 真 CLI agent：Codex / Claude skill 替换假 agent

**What to build:** 处理编排通过统一 `AgentRunner` seam 支持真实 Codex CLI 或 Claude CLI，调用「处理收件箱」skill：对收件箱口播做**轻整理**、按**日记为轴**写回，可选抽出**想法**并互链，**待查**只打标；写出合规**回执**。Agent 仍不得删除收件箱、不得 git commit/push；删除与提交继续只由编排脚本在验收通过后执行。01 中的失败、隔离、上限、锁、白名单行为保持有效。可用少量真实口播样例分别抽查两种 CLI 的结果。

**Blocked by:** 01 — 处理编排全契约（假 agent）

**Status:** ready-for-human

- [x] skill 文档与 Codex/Claude runner adapter 可被编排调用（缺 provider 配置时 CLI 拒绝启动）
- [ ] Codex skill 可被编排非交互调用，并写出 `_processor` 回执（**等 CODEX_BIN / Codex 登录**）
- [ ] Claude skill 可被编排非交互调用，并写出 `_processor` 回执（**等 CLAUDE_BIN / Claude 凭证**）
- [ ] 至少一条真实口播样例：日记侧有轻整理写回，语气不升格成代写腔（人工抽查即可）
- [ ] 若模型判为独立想法：想法笔记存在且与日记有链接关系；避免无意义双份全文
- [ ] 待查仅标记，不生成调研式伪答案
- [x] Agent 运行后：inbox 的删除仍只发生在脚本验收通过之后（假 agent「done 缺 diary」已证明拦删）
- [x] 既有编排自动化（假 agent 套件）仍可通过；真 agent 不强制每次 CI 打真模型

## Comments

- 2026-07-29 implement：原 Claude runner 骨架完成于 `skills/处理收件箱/SKILL.md` + `src/agent/claude-runner.ts`；后续扩展为 Codex/Claude 可切换 adapter。剩余为两个 CLI 的人工/真模型验收。
