# 06 — 托底节奏、STATE 可见与实机演习

**What to build:** 处理环作为长期**职责**可值守：在唤醒之外具备定时托底；单实例锁在真实调度下不双开；`_processor` 状态与隔离区进入 vault 后可在 Obsidian 侧看见；按清单完成连倒多条、故意失败进隔离、git 冲突中止且收件箱留守等演习并留下简短记录。用户无需手动点「处理」也能依赖唤醒 + 托底消化收件箱（PC 可关机，宿主在 VPS 的前提由部署满足）。

**Blocked by:** 03 — 投递唤醒处理轮（假 agent 贯通）；04 — 捕捉端接真投递；05 — 真 agent：Claude skill 替换假 agent

**Status:** ready-for-human

- [x] 定时托底配置说明存在（`.env.example` CRON + `docs/ops/field-drill.md`）；与唤醒靠锁串行（单测已覆盖锁）
- [x] STATE 由编排写入 `_processor/STATE.md`（进 vault 的约定已实现；真 push 等 VPS git）
- [ ] 演习：连续多条投递最终进入日记（或隔离），收件箱成功项被清理
- [ ] 演习：强制失败路径导致 attempts/隔离，原文不丢
- [ ] 演习：模拟或真实制造 pull/冲突时本轮中止、inbox 留守（或按 ADR 记录的行为）
- [x] 简短演习记录模板写在 `docs/ops/field-drill.md`

## Comments

- 2026-07-29 implement：代码侧 STATE/锁/cron 文档就绪；实机三场演习等用户回填密钥与 VPS 后执行。
