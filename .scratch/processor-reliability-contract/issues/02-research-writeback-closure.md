# 02 — 研究状态与合法简报写回闭环

**What to build:** 让研究任务状态、来源笔记、研究简报、处理轮结果和 STATE 保持一致，并拒绝当前轮日记或想法中指向不存在或不合法研究简报的链接。

**Blocked by:** `processor-reliability-contract/issues/01-processor-errors-visible.md`

**Status:** done

- [x] `pending`、`partial`、`blocked` 和 `complete` 的含义在任务记录、处理轮结果和 STATE 中一致。
- [x] 未完成研究任务数量包含所有非 `complete` 状态，可重试数量单独计算。
- [x] 研究失败或证据不足时，日记、想法和原始收件项保留，来源继续保持未完成标记。
- [x] 研究简报只有通过路径、frontmatter、任务问题、证据章节、来源双链和来源状态验收后才能标记 `complete`。
- [x] 当前轮实际变更的日记和想法中出现研究链接时，目标必须是真实存在的顶层合法研究简报。
- [x] 研究 runner 写出受限或旧格式简报时不会报告完成。
- [x] 旧的成功断言与新的失败语义统一，全量测试和类型检查通过。
