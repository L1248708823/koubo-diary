# 生产环境问题交接记录

> 记录时间：2026-08-05 14:18:07 CST（Asia/Shanghai）
>
> 文档性质：生产环境问题记录、初步调研和建议，不将当前判断视为已确认根因。
>
> 本文不记录 token、密钥或真实配置值。服务器路径仅用于说明部署位置。

## 1. 发生情况

### 1.1 收件与处理

- 2026-08-05 13:21 左右，通过网页提交一条测试内容，收件 id 为 `20260805-132111-osbwtw`。
- ingest 日志记录 `ingest.delivered`，文本长度为 50；该内容先写入日记仓 `_inbox/`。
- 当时生产配置为 `WAKE_MODE=none`，因此投递成功后没有自动启动一次性 `koubo-processor.service`。
- 手动启动 processor 后，主处理 agent 正常退出，日志记录 `processor.acceptance ok=true`。
- 日记写回、收件项删除和日记仓提交均发生；`_processor/last-run.json` 记录该条收件的 `status: done`，`ideas: []`。
- 当前输入是一个待研究问题，没有创建想法文件不一定是异常，需要结合产品规则继续确认。

### 1.2 研究阶段

- 本次 processor 选中了 2 个研究任务：本次测试产生的微服务问题，以及此前遗留的 LLM 流程编排问题。
- 两次 Codex research runner 的进程退出码均为 0，但任务状态均被写为 `blocked`。
- 日志给出的原因是：`Codex 研究 runner 完成但没有发现合法研究简报`。
- 本次任务目录下出现了一份包含分析文字的 Markdown 文件，但其状态仍为 `blocked`，不能据此视为完成的研究简报。
- processor 在日记主处理成功、研究任务未完成的情况下最终以退出码 1 结束。

### 1.3 自动触发部署变化

- 为避免后续每条收件都需要人工启动 processor，生产环境随后增加了 `koubo-processor.path`，监听 `/run/koubo/processor.wake`。
- ingest 的生产运行配置随后改为 `WAKE_MODE=file`，watcher 已设置为开机启动。
- 目前只完成了 systemd 状态验收，尚未用新的真实收件验证“提交后自动启动 processor”完整链路。

## 2. 初步调研情况

### 2.1 外部网络访问

目前只能确认以下两件事：

- 服务器宿主机当前可以解析并访问 CNCF、Martin Fowler、Microsoft Learn 和 AWS 文档地址，测试请求返回 HTTP 200。
- 研究简报正文记录了研究 runner 当时无法解析目标站点 DNS，但这条信息来自研究 agent 的写回内容，尚不能单独证明失败发生在宿主机网络层。

初步怀疑：研究 runner 使用的 Codex 子进程和宿主机处于不同的网络权限环境。当前代码通过 `codex exec ... -s workspace-write` 启动研究进程，没有明确配置研究子进程的网络访问能力。是否确实由该 sandbox 设置导致，需要在同一 runner 环境中做最小网络验证后确认。

### 2.2 研究技能是否被实际加载

从代码看，研究 runner 的工作目录是日记仓，prompt 中传入的是技能名称 `research-brief`，同时 prompt 禁止研究 agent 读取工具仓。实际技能文件位于工具仓的 `skills/research-brief/SKILL.md`。

因此存在一个待确认的实现缺口：研究 agent 可能只收到技能名称和部分 prompt 规则，没有实际读取完整技能正文。若该判断成立，agent 可能不知道完整的 frontmatter、证据结构和双向链接契约，从而写出普通 Markdown 而非可验收简报。

### 2.3 研究简报验收

当前验收代码要求简报至少满足以下条件：

- frontmatter 中存在 `type: research-brief`、匹配的 `task_id`、`research_status: complete`、日期和问题。
- 简报与来源日记或想法存在双向 wikilink。
- 研究正文包含问题、证据或事实、分析、未知点/限制、停止依据和来源内容。
- 外部事实有可核验来源，或明确写出无法核验的限制。
- 来源笔记在完成时关闭 `needs_research` 并清除错误状态。

本次生成文件的开头是普通标题，正文记录了无法访问来源和 `blocked` 状态；它包含分析框架，但没有表现为已完成的研究简报。当前更像是“部分研究草稿被保留、验收未通过”，而不是“研究内容完全没有生成”。

### 2.4 processor 退出码

从现有日志看，退出码 1 主要用于暴露研究阶段未完成，避免监控系统把整轮工作误认为完全成功。日记主流程已经成功并不会因此回滚。

这是否符合产品期望仍需决定：一种选择是保留非零退出码，方便运维告警；另一种选择是日记/想法主流程成功时返回 0，同时把研究阻塞作为独立状态和告警。两者对监控和人工排查的含义不同，本文不替产品做最终决定。

## 3. 建议

### 3.1 优先验证研究子进程的网络权限

建议在临时 vault 中执行一次最小验证：让同一套 Codex research runner 只访问一个公开 HTTPS 页面，记录 DNS、HTTP 状态和进程日志，不写入真实日记仓。

若确认 sandbox 网络被关闭，可只给研究子进程开启网络能力，继续保留 `workspace-write` 和文件白名单；不建议直接改成 `danger-full-access`。网络权限应限定在 research runner，不应扩大普通处理 agent 的权限。

### 3.2 让研究 agent 获得真实技能契约

建议在本地代码中读取 `skills/research-brief/SKILL.md`，以受控方式将其正文注入研究 prompt，或提供一个明确的只读技能目录。不要只传入技能名称后期待子进程自行找到工具仓文件。

同时保留现有验收器，不建议为了让任务变绿而降低 `type`、来源、日期和双链要求。研究 agent 可以自主分析，但写回必须满足机器可检查的契约。

### 3.3 先用临时任务验证，再重试真实任务

网络和技能注入修复后，建议按以下顺序验证：

1. 临时 vault + 单个简单研究问题。
2. 确认生成的简报 frontmatter、证据和双链能通过验收。
3. 再重试当前两个 `blocked` 任务。
4. 最后用一条新的网页收件验证自动唤醒链路。

在修复前不建议反复启动真实 processor，因为每次可能消耗数分钟的研究调用，而且不会改变 `blocked` 的根因。

### 3.4 重新评估 processor 的失败边界

建议保留“研究未完成必须可见”的原则，但把状态拆开记录：

- 日记/想法主处理结果。
- 研究任务结果。
- 本轮 processor 是否需要被 systemd/监控标红。

这样既不会掩盖研究阻塞，也不会让“日记已经写好”与“整轮完全失败”在运维界面上混成一个结果。

### 3.5 生产自动触发的后续验收

当前 watcher 只完成了单元状态检查，建议下一次真实提交时观察：

- ingest 是否记录 `wakeMode: file` 并写入唤醒文件。
- `koubo-processor.path` 是否启动 processor。
- processor 是否获得锁并处理收件项。
- 研究耗时较长时，新的唤醒事件是否会在当前 processor 结束后再次得到处理。

如发现处理期间的多个提交被合并或遗漏，再考虑增加定时托底；在此之前不建议直接引入更多常驻脚本。

## 4. 待确认事项

- Codex research sandbox 是否确实没有网络权限。
- 研究技能正文应通过 prompt 注入、只读目录还是独立 MCP 提供。
- 研究失败时 processor 是否继续返回非零退出码。
- 自动 watcher 是否需要 cron/timer 托底。
- 研究结果是否需要在网页端显示，还是继续只写回 Obsidian 日记仓。

## 5. 代码参考

- `src/research/codex-runner.ts`：研究命令参数、prompt 和合法简报发现逻辑。
- `src/research/brief.ts`：研究简报 frontmatter、证据和双链验收逻辑。
- `skills/research-brief/SKILL.md`：研究状态、来源策略和写回契约。

