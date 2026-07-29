# 调研方案：Loop Engineering × 口播日记处理环

> 给其他模型 / 子代理用的完整调研 brief。主会话也可并行跑 `/research`。
> 产出应落到：`temp/research-loop-engineering.md`

## 用户已澄清的概念（调研时以此为准，不要另造定义）

**Goal**：有终点的一次目标。人发现问题并发起；Agent 拆任务、推进、检查；达成退出条件即结束。  
例：把登录模块重构掉；更新某一章过时教材。

**Loop**：一类会持续出现的工作上的**职责**。Agent 在职责范围内反复：观察 → 判断是否行动 → 处理能处理的 → 汇报；单轮可结束，职责持续存在。人是边界制定者与监督者，不是任务搬运工。  
例：这个仓库的日常 issue 分流归你；教材的日常维护归你。

关系：Loop 可在观察后**发起** Goal；连续十个 Goal ≠ 一个 Loop。分水岭是「找活干」是否也由系统完成。

Loop 前提（用户文中）：
1. 被操作系统要有接口（CLI / MCP / API， ideally Agent-friendly）
2. 能把一轮里要做的事描述清楚
3. 结果可检查（不可检的只能人工审）
4. 多 Agent 交叉校验；禁止自己做自己查

## 本项目约束（口播日记）

已锁定（见 `CONTEXT.md`、`docs/adr/0001-*.md`、`docs/adr/0002-*.md`、`temp/capture/`）：

- 个人工具，不是多用户产品
- 不自研 STT；系统语音输入法 → 文本
- **捕捉端**（PWA，B 在场感 UX）只向收件箱**新建**文件
- **处理端**独占日记/想法正文写入（避免与 Obsidian Git 冲突）
- 用户有：PC + Obsidian Git 自动 pull/commit/push；另有**云端服务器**；周末 PC 可能不开

用户明确：**不希望手动点「处理」**；希望处理侧是 Loop（职责），不是每次 Goal。

## 调研问题清单（必须逐条回答，附来源）

### 1. 概念地图

- 业界是否已有与「Loop Engineering」同构的公开术语？（continuous agent、duty agent、cron agent、supervisor、ambient agent 等）
- 与 AutoGPT / 早期 autonomous agent「死循环」叙事的差别（避免把 Loop 误写成 while true 狂转）
- Goal 型产品/框架 vs Loop 型编排各自代表作（只写能找到一手文档的）

### 2. 托管形态对比（核心）

对每一种，写清：触发源、状态存哪、密钥存哪、PC 关机时行为、与 Git/Obsidian 的冲突风险、成本、适合的职责粒度。

| 候选 | 必答 |
|------|------|
| PC 常驻 daemon / folder watcher | |
| 用户已有云 VPS 上常驻 | |
| GitHub Actions schedule + path filter | |
| Claude Code：CLI headless、hooks、scheduled tasks、`/loop`（若存在） | |
| Anthropic Agent SDK / Messages API 自建 runner | |
| 其他有文档的 agent 常驻方案（找到什么写什么，不虚构） | |

特别回答用户原话：

> 「周末电脑不开机就无法持续 loop 了吧」  
> 「有没有比自己云服务器更合理的方式」

### 3. 把 Claude Code 放进环的「act」步

- 非交互调用 Claude Code 的官方方式（子进程、`claude -p`、SDK…）以当前文档为准
- Skill 是否适合表达「处理收件箱」这一职责；skill 与 system prompt / 定期任务如何组合
- 一轮 Loop 的建议形状：观察（list inbox）→ 判断（空则退出本轮）→ 对每条口播开 Goal 或内部步骤 → 交叉校验 → 写结果/通知
- 「禁止自己做自己查」在单人个人工具上如何最小实现（第二模型、规则校验、diff 审阅队列）

### 4. 针对口播日记的 2～3 套可落地架构

每套包含：组件图（文字即可）、事件流、失败与重试、人审入口、v1 最小切片。  
至少一套**不依赖周末开 PC**；至少一套**密钥尽量留本机**。

### 5. 明确不建议的做法

例如：捕捉端直接改正文；无接口的「纯聊天里提醒自己处理」冒充 Loop；无观察信号的死轮询烧钱；等等。

## 产出格式

```markdown
# Loop Engineering 调研 · 口播日记

## 摘要（≤10 行）
## 概念：Loop vs Goal（含来源）
## 托管形态对比表
## Claude Code / Agent 作为执行器
## 推荐架构（排序 + 取舍）
## 对口播日记处理环的直接含义
## 未决问题
## 来源列表
```

## 质量条

- 每个关键机制声明带 URL 或本地路径
- 找不到就写「未找到一手来源」，禁止编造产品能力
- 中文为主，专有名词保留英文
- 篇幅以「能做决定」为准，不堆水文

## 调研完成后

在文件末尾加：

```markdown
## 给主 grill 会话的决策输入
- 问题 6（环的宿主）可选答案修订为：…
- 若采纳 Loop，v1 职责一句话：…
- 仍需用户拍板的只有：…
```