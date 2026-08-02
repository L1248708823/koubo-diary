# 05 真实研究 runner 与配置接入

**What to build:** 研究阶段能够调用独立研究 skill 和真实 Codex runner 执行一次人工可检查的研究任务，同时把模型、思考能力、CLI 和超时作为运行配置传入，保持 vault 与工具仓边界。

**Blocked by:** 04 假来源研究简报闭环

**Status:** ready-for-human-smoke

- [x] 研究任务可以通过统一 runner 调用研究 skill，输入来源、问题、当前日期和目录配置，输出可被研究简报闭环验收的写回结果。
- [x] 模型、思考能力、CLI 路径、超时和研究运行限制均来自配置；本地 Codex 联调可显式使用 `gpt-5.6-luna` 与 `max`，不把值写死在 skill 内容中。
- [x] 真实研究优先使用国外和国际来源，并主动覆盖原始资料、独立资料、反方观点、证据边界和未知点；国内官方资料只能按规则作为补充。
- [x] runner 不执行 Git，不修改收件箱、隔离区、密钥或工具仓；本地模式只操作临时 vault。
- [x] 真实 Codex 只做人工 smoke test，自动化测试继续使用假来源 adapter，不依赖外部站点、凭证或模型措辞。
- [x] 研究失败、来源无法核验或访问受限时写入 `partial` 或 `blocked`，不生成无来源确定性结论。

## 验证记录

- 自动化：`npm.cmd test -- --reporter=dot --silent`，13 个测试文件、70 条测试通过。
- 类型检查：`npm.cmd run typecheck` 通过。
- 变更检查：`git diff --check` 通过。
- 已覆盖：研究配置读取、Codex 参数映射、任务上下文 prompt、CLI 失败保留 `needs_research: true`、无新简报和研究写回二次验收。
- 待人工：使用有效 Codex 登录和临时 vault 执行 `npm.cmd run local:setup`、`npm.cmd run local:processor`，检查真实来源、模型输出、双链、`complete`/`partial`/`blocked` 状态和本地无 Git 边界。
