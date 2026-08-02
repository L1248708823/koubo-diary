# 06 研究处理环全链路回归与 smoke test

**What to build:** 用临时 vault 证明连续投递、内容整理、自动研究、失败恢复和本地运行边界能够组成稳定处理环，并留下真实 Codex 研究的人工验收记录。

**Blocked by:** 02 合并唤醒与有界连续批处理；05 真实研究 runner 与配置接入

**Status:** ready-for-human-smoke

- [x] 五条快速投递最终都得到唯一处理结果，内容整理按日记合并，研究候选进入研究阶段，成功项才从收件箱清理。
- [x] 纯日常、独立想法、想法加待查和来自日记的待查任务分别通过回归测试，研究失败时原文和候选仍保留。
- [x] 三大项视频分析样例验证技术可行性、证据限制、健康边界和个人最小验证路线，不输出个人医学诊断。
- [x] 回归测试覆盖旧回执、漏报、重复项、收件箱越权、嵌套 `Yan帳`、同名覆盖、锁占用、单轮上限和本地模式无 Git 操作。
- [x] 现有收件 HTTP 的鉴权、输入校验、CORS、时间字段和 `delivered: true` 契约继续通过。
- [ ] 本地 smoke test 记录真实 Codex 的研究来源、研究状态、双链、失败边界和已知人工检查限制。

## 验证记录

- 自动化：`npm.cmd test -- --reporter=dot --silent`，13 个测试文件、70 条测试通过。
- 类型检查：`npm.cmd run typecheck` 通过。
- 前端构建：`npm.cmd run web:build` 通过；仅保留 `local-config.js` 非 module 提示和大 chunk 提示。
- 变更检查：`git diff --check` 通过。
- 新增回归：五条收件项批处理与研究阶段联动、想法与待查轴同时成立并生成研究简报。
- 待人工：使用 `config/local-codex.env` 和临时 vault 执行真实 Codex smoke test，记录来源质量、状态、双链、失败保留和本地无 Git 边界。
