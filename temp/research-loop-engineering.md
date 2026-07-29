# Loop Engineering

> 调研日期：2026-07-28  
> 概念出现时间：2026-06 起（Addy Osmani / Cobus Greyling / Boris Cherny 等公开表述）

## 一句话

**Stop prompting. Design the loop.**  
不再自己逐条 prompt agent，改为设计一个会发现工作、调度 agent、验证结果、持久化状态的控制系统。

## 定义

| 术语 | 含义 |
|------|------|
| **Loop Engineering** | 设计「会 prompt agent 的系统」，而不是持续当 prompter |
| **Loop** | 带调度、状态、验证链的控制环；可跨 session 反复运行 |
| **Harness** | 单次 agent session 的环境：工具、权限、规则、沙箱 |
| **Goal** | 有退出条件的一次目标；达成即结束 |
| **Skill** | 固化的项目知识（约定、禁区、构建命令等），降低 Intent Debt |
| **STATE / Memory** | 落盘状态（如 `STATE.md`），跨 session 不丢 |
| **Maker / Checker** | 实现者与验证者拆分；禁止自己做自己查 |
| **Worktree** | 隔离工作树，并行改代码不互相踩 |

关系：

```text
Harness = 一次 session 的环境
Loop    = harness + schedule + state + verification chain
```

Loop 可在观察后**发起** Goal；连续多个 Goal ≠ 一个 Loop。分水岭是「找活干」是否也由系统完成。

Boris Cherny（Claude Code）：*“I don’t prompt Claude anymore. I have loops running that prompt Claude… My job is to write loops.”*

## 六个积木（Five Primitives + Memory）

1. **Automations / Scheduling** — 心跳（`/loop`、cron、GitHub Actions…）
2. **Worktrees** — 并行隔离
3. **Skills** — 持久意图与约定
4. **Plugins & Connectors（MCP）** — 接 GitHub / Linear / Slack 等
5. **Sub-agents（Maker / Checker）** — 写与验分离
6. **Memory / State** — durable 状态文件或看板

最小可跑 Loop：`schedule + 一个 triage skill + 一个 STATE 文件`。

## 成熟度（Readiness Levels）

| Level | 行为 |
|-------|------|
| **L0 Draft** | 只有意图文档 |
| **L1 Report** | 观察 → 写状态 / 报告，不自动改代码 |
| **L2 Assisted** | 小修复 + 独立 verifier，高风险 escalate |
| **L3 Unattended** | 无人值守；预算、denylist、circuit breaker、human gate 齐全 |

**第一周停在 L1。** 多数失败来自一上来就 L3。

## 相邻概念（Osmani）

| 概念 | 要点 |
|------|------|
| **Agent Harness Engineering** | 管单次 session 环境；Loop 管跨时间编排 |
| **Intent Debt** | 每轮冷启动靠猜；用 Skills 偿还 |
| **Comprehension Debt** | 代码增速超过人理解；必须读 Loop 产出 |
| **Cognitive Surrender** | 把判断外包给系统，自己只按 go |
| **Orchestration Tax** | 并行 agent 的协调成本 |
| **Factory Model** | 把软件生产当成流水线运营 |

## 生产 Pattern（常见）

| Pattern | 节奏 | 风险 |
|---------|------|------|
| Daily Triage | 1d–2h | 低 |
| Issue Triage | 2h–1d | 低 |
| PR Babysitter | 5–15m | 中 |
| CI Sweeper | 5–15m | 中 |
| Dependency Sweeper | 6h–1d | 中 |
| Post-Merge Cleanup | 1d–6h | 低 |
| Changelog Drafter | 1d / tag | 低 |

## 实践与工具

### 参考实现 / 模式库

- **[cobusgreyling/loop-engineering](https://github.com/cobusgreyling/loop-engineering)**（2026-06-09，~9.5k★）  
  Pattern、starter、CLI（`loop init / doctor / audit / cost / sync / context / worktree / gate`）  
  Companion：`harness-foundry`、`outerloop`、`memory-engineering`、`fleet-engineering`、`goal-engineering`

```bash
npx @cobusgreyling/loop init . --pattern daily-triage --tool claude
npx @cobusgreyling/loop doctor .
```

`--tool`：`grok` / `claude` / `codex` / `opencode`（Cursor / Windsurf 需手动抄 skill）

### 运行时

| 项目 | 定位 |
|------|------|
| **[LoopFlow](https://github.com/faisalishfaq2005/loopflow)** | Claude Code 专用；YAML 声明 pipeline + gate + budget + memory |
| **[valkor-ai/loom](https://github.com/valkor-ai/loom)** | 交付型 harness：plan → build → test → fix → handoff，状态在 `.loom/` |
| **[GaosCode/PlanWeave](https://github.com/GaosCode/PlanWeave)** | 文件即节点的 task graph；实现 / review 可 claim、可恢复 |
| **[baidu-baige/LoongFlow](https://github.com/baidu-baige/LoongFlow)** | Plan-Execute-Summary + 结构化记忆 |
| **[open-spek/loop](https://github.com/open-spek/loop)** | 测试门控，把 Spek 变成可验证实现（与定时运维 Loop 不同义） |

### 工具原生能力

Claude Code 等已把积木做成一等公民：`/loop`、`/goal`、`/schedule`、worktree isolation、skills、subagents。常见用法如 `/loop 5m /babysit`、`/loop 30m /slack-feedback`。

### 现场案例

- [Brittany Ellich：8 天 108 PR](https://brittany-ellich.offprint.app/a/3mrjj34puva23-108-prs-in-eight-days-accidentally-discovering-loop-engineering)（2026-07）— 用 agent 持续啃 task board；社区质疑 PR 数量 ≠ 质量。

## 设计纪律（Checklist 精简）

1. 单一清晰 goal + 明确 non-goals  
2. 第一周 L1 report-only  
3. Maker / Checker 分离；verifier 必须跑测试并给证据  
4. STATE 每轮读写并 prune 已关闭项  
5. Escalation 触发条件写死（次数、歧义、风险路径）  
6. 路径 denylist（auth / payments / secrets / infra）  
7. Token budget + max iterations + kill switch  
8. 成功指标 = 省时间且质量不塌，不是 PR 数  

## 常见失败模式

| 模式 | 症状 | 缓解 |
|------|------|------|
| **Infinite Fix Loop** | 同一项修 5+ 次不收敛 | 次数硬顶 → escalate |
| **Verifier Theater** | 口头 pass，CI 仍红 | 独立 verifier + 真跑测试 |
| **State Rot** | STATE 全是幽灵 ticket | 每轮 prune |
| **Token Burn** | 高频 + 重 sub-agent 账单炸 | 先廉价 triage；空则 early exit |
| **Over-Reach** | 改 denylist 路径 / 大重构 | 最小 diff + 路径门禁 |
| **Comprehension Debt Spiral** | 人不再读产出 | 强制人审非琐碎变更 |
| **Cognitive Surrender** | 「loop 会处理」代替判断 | human gate + 质量指标 |
| **Parallel Collision** | 多 agent 改同文件 | worktree + 状态锁 |
| **Escalation Failure** | 卡住无人知 | 升级必通知 + 超时告警 |

## 分层栈（社区常见）

```text
memory-engineering → loop-engineering → harness-foundry → outerloop → fleet-engineering
   (persist)            (patterns)         (runtime)        (verdict)     (population)
```

## 关键来源

| 来源 | 链接 |
|------|------|
| Addy Osmani — Loop Engineering | https://addyosmani.com/blog/loop-engineering/ |
| Cobus Greyling — essay | https://cobusgreyling.substack.com/p/loop-engineering |
| cobusgreyling/loop-engineering | https://github.com/cobusgreyling/loop-engineering |
| LoopFlow | https://github.com/faisalishfaq2005/loopflow |
| Loom | https://github.com/valkor-ai/loom |
| PlanWeave | https://github.com/GaosCode/PlanWeave |
| HN：Osmani 文（2026-06-13） | https://news.ycombinator.com/item?id=48514387 |
| HN：108 PRs 案例（2026-07-27） | https://news.ycombinator.com/item?id=49068870 |
| The Register 评论 | https://www.theregister.com/ai-and-ml/2026/06/24/loop-engineering-latest-ai-buzzword-still-needs-humans-in-the-loop/5261735 |
| Pragmatic Engineer | https://newsletter.pragmaticengineer.com/p/what-is-loop-engineering |
| LangChain — The Art of Loop Engineering | https://www.langchain.com/blog/the-art-of-loop-engineering |

## 判断（简）

概念抓住真实杠杆转移：瓶颈从「写好一句 prompt」移到「系统持续、安全、可审计地自己找活干」。泡沫也存在——cron + agent 硬贴名字、无 Maker/Checker / State / Budget 的不算合格 Loop。可落地的最小验证：在真实 repo 跑一周 L1 Daily Triage，看 `STATE.md` 是否可读、是否真的省事。
