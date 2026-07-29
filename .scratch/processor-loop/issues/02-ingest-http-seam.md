# 02 — 收件接口：鉴权投递只进收件箱

**What to build:** 提供 HTTPS（测试可为本地）投递接口：携带正确 Bearer 与非空口播文本时，仅在 vault **收件箱**新建一条带约定 frontmatter 的文件，响应表示投递成功（`delivered: true`），且明确不表示已整理；无 token、错 token 或空文本时拒绝，vault 不留下新的收件箱脏文件；任何成功或失败路径都**不写**日记/想法、不调用处理 agent。可选：成功后发出「可跑处理轮」的唤醒信号（本票至少预留挂钩；与编排贯通见 03）。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 合法 Bearer + 非空 text：收件箱仅新建一文件，响应含投递成功语义
- [x] 缺少或错误 Bearer：4xx 类失败，收件箱无新文件
- [x] 空 text：拒绝，收件箱无新文件
- [x] 成功路径不创建/不修改日记或想法正文
- [x] 成功路径不调用处理 agent
- [x] 自动化测试覆盖鉴权、空文本与「只写收件箱」契约（临时 vault）

## Comments

- 2026-07-29 implement：`src/ingest/server.ts`；`onWake` 挂钩已预留；测试 `server.test.ts` 全绿。
