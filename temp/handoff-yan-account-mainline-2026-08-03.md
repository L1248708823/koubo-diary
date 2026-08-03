# Handoff: Yan帳 主线契约与下一阶段实现

日期：2026-08-03
仓库：`D:\前端\需求开发文件夹\口播日记`

本交接用于新会话继续工作。当前目标是保持 Yan帳 现有主流程，收紧领域边界、提示词维护和错误可见性，不进行整体重写。

## 用户已确认的方向

- Yan帳 是产品主题和用户可见总称，替代旧的「口播」产品命名。
- 内部单条原始输入称为收件项或原始记录，避免把产品名和数据实体混在一起。
- 日记、想法、待查、研究任务、研究简报和回执保持独立边界。
- 主要关注写法、业务边界、异常是否被吞掉和防御性代码是否过量。
- 不以现有测试样例代替完整业务分析，测试只固定外部契约。

## 本会话已完成

### 领域文档

- 更新 `CONTEXT.md`，统一 Yan帳、收件项、日记、想法、待查和研究任务定义。
- 新增 `docs/adr/0007-yan-account-replaces-koubo-term.md`，记录 Yan帳 命名决策。

### 规格

- `.scratch/yan-account-domain-contract/spec.md`
  - Yan帳 领域与内容整理契约。
  - 日记、想法、待查、研究任务和研究简报边界。
  - 处理 prompt 单一来源和人工内容审查规则。
- `.scratch/processor-reliability-contract/spec.md`
  - 异常显式失败。
  - 工作区、Git、STATE、研究状态和研究写回一致性。
  - 研究链接和非法简报验收。

### 已发布 tickets

- `.scratch/yan-account-domain-contract/issues/01-processor-prompt-single-source.md`
- `.scratch/yan-account-domain-contract/issues/02-yan-account-user-copy.md`
- `.scratch/processor-reliability-contract/issues/01-processor-errors-visible.md`
- `.scratch/processor-reliability-contract/issues/02-research-writeback-closure.md`
- `.scratch/processor-reliability-contract/issues/03-mainline-readonly-audit.md`

当前无阻塞 ticket：

1. 处理 prompt 单一来源与 Yan帳 语义落地。
2. 处理环异常显式失败。

推荐优先实现处理环异常显式失败，因为它直接影响收件项所有权、Git 变更检查、STATE 状态和失败恢复。

## 当前未提交工作区

以下源代码改动来自此前研究链路诊断，必须保留，不能使用 destructive git 命令清除：

- `src/processor/accept.test.ts`
- `src/processor/orchestrator.test.ts`
- `src/research/codex-runner.test.ts`
- `src/research/codex-runner.ts`
- `src/research/stage.ts`
- `src/research/tasks.ts`
- 删除 `temp/handoff-next-session.md`，这是此前用户明确要求删除的旧交接文件。

本会话新增的领域和 tracker 文件属于有效工作，也需要保留。

## 验证状态

- `npm.cmd run typecheck`：通过。
- `npm.cmd test -- --run`：14 个测试文件中 12 个通过，85 条测试中 82 条通过，3 条失败。
- 失败 1：研究链接指向不存在简报时，`acceptRound` 尚未拒绝。
- 失败 2、3：旧测试仍期待研究 `partial` 或 `blocked` 时轮次为 `success`，当前规格要求返回 `failed`。
- Git 检查仍会提示现有源代码改动存在 LF/CRLF 转换，Windows 下提交前需要处理。

## 下一会话建议

1. 读取本文件、对应 ticket、`CONTEXT.md`、ADR-0005、ADR-0006、ADR-0007 和两份 spec。
2. 从一个 ticket 开始，不要同时修改两个无阻塞 ticket 的重叠文件。
3. 以最高处理轮 seam 驱动 TDD，先建立失败反馈，再做最小实现。
4. 实现完成后运行全量测试和 typecheck，再进行 Standards 与 Spec 双轴 review。
5. 不启动真实 processor、真实 Codex 研究服务或真实 vault 写入，除非用户明确要求。
6. 不自动合并、迁移或删除真实 vault 中的历史想法、嵌套 Yan帳 和旧研究简报。

## 新会话启动语句

请读取 `temp/handoff-yan-account-mainline-2026-08-03.md`，保留当前未提交改动，从 `processor-reliability-contract/issues/01-processor-errors-visible.md` 开始实现。使用 TDD，先检查现有 seam 和失败测试，不要重写主流程，不要启动真实 vault 服务。
