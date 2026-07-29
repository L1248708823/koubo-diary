# Spec: 处理环 v1（口播 → 收件箱 → 日记/想法）

Status: ready-for-agent  
Feature slug: `processor-loop`  
Sources: `CONTEXT.md`, `docs/adr/0001`–`0005`, `temp/tech-design-processor-loop.md`, grill 共识, seams A（编排 + 投递）

## Problem Statement

我用系统语音输入法随口倒出的口播，需要自动变成 Obsidian 里按日可回顾的日记，重要灵感还要能单独当想法查阅；我不想每次手动点「处理」，周末电脑不开也希望环还在转。现在只有捕捉端手感原型和架构文档，没有真正的投递通道与处理环：口播进不了 vault 收件箱，更不会被整理进正文。若捕捉端直接改日记，又会和 PC 上 Obsidian Git 抢同一文件。

## Solution

我在手机上用捕捉端（B 在场感）把口播**投递**进 vault 的**收件箱**（只新建文件）。VPS 上的**处理环**被唤醒或按节奏醒来：观察收件箱，有则让 AI 做**轻整理**与归类写回（**日记**为轴，可选抽出**想法**并双链，**待查**只打标），写出机器可读**回执**；编排脚本做机械验收，通过后才删除已处理收件箱条目并 git 提交推送。空收件箱则本轮安静结束。我在 PC 用 Obsidian Git 拉下来阅读；卡住时看 `_processor` 状态与**隔离区**，不靠手机推送。

## User Stories

1. As a 使用者, I want 用系统语音输入法说出一段口播并一键投递, so that 灵感稍纵即逝时五秒内能抓住。
2. As a 使用者, I want 连续投递多条而不切换界面, so that 冥想前可以连倒几段。
3. As a 使用者, I want 投递成功后输入区清空并回焦, so that 可以马上说下一条。
4. As a 使用者, I want 投递失败时正文仍留在输入框并看到原因, so that 不会丢稿。
5. As a 使用者, I want 捕捉端只显示今日已投数量与只读列表, so that 有在场感但不在手机改正文。
6. As a 使用者, I want 捕捉端不选手动「日记/想法」, so that 投递路径保持最短。
7. As a 使用者, I want 投递成功只表示进入收件箱, so that 我不会把「已投递」误当成「已整理进日记」。
8. As a 使用者, I want 不手动点「处理」, so that 处理是处理环的职责而不是我的 Goal。
9. As a 使用者, I want 周末 PC 关机时环仍能跑, so that 出差或休息也不堆死在收件箱。
10. As a 使用者, I want 同一天多条口播合并进同一篇日记, so that 按日回顾而不是一篇口播一篇日记。
11. As a 使用者, I want 日记里仍能听出是我的口气, so that 整理不会变成代写润色。
12. As a 使用者, I want 独立灵感落成想法笔记并与当日日记互链, so that 后期既可按日也可按主题查阅。
13. As a 使用者, I want 避免日记与想法双份全文, so that vault 不灌水、图谱仍然清楚。
14. As a 使用者, I want 需要后续了解的内容被标成待查, so that 以后能找回来开调研而不在 v1 伪回答。
15. As a 使用者, I want 收件箱里的原文在处理失败时还在, so that 自动环搞砸也不会丢口播。
16. As a 使用者, I want 同一条反复失败后进入隔离区, so that 环不会无限烧同一条。
17. As a 使用者, I want 在 PC 打开 vault 就能看到处理状态, so that 不用另做监控产品。
18. As a 使用者, I want 隔离区里的条目不再被自动啃, so that 我可以择时人工处理。
19. As a 使用者, I want 单轮只消化有上限的条数, so that 一次连倒很多不会一次打爆费用与时长。
20. As a 使用者, I want 空收件箱时环立刻结束本轮, so that 定时心跳不空转烧模型。
21. As a 使用者, I want 投递使用共享密钥经 HTTPS, so that 陌生人不能往我的收件箱塞文件。
22. As a 使用者, I want 密钥不进 git 仓库, so that vault 历史里不会泄露 token。
23. As a 使用者, I want 处理端独占日记与想法正文的写入, so that 不与捕捉端、不与双处理端双写冲突。
24. As a 使用者, I want GitHub 只当远程仓库, so that 我不依赖 Actions 冷启动来消化口播。
25. As a 使用者, I want 投递后尽快触发一轮处理, so that 体感接近「送进去不久能在日记里看见」。
26. As a 使用者, I want 另有定时托底, so that 唤醒丢了也不会永远漏处理。
27. As a 使用者, I want 同时只跑一个处理实例, so that 两轮不会抢同一收件箱与同一日日记。
28. As a 使用者, I want AI 不直接 git push, so that 模型胡写不能直接进远程历史。
29. As a 使用者, I want AI 不直接删收件箱, so that 只有验收通过的 done 才会被脚本删掉。
30. As a 使用者, I want 白名单外的文件变更导致整轮失败, so that 家目录或密钥文件不会被提交。
31. As a 使用者, I want git 冲突时本轮停止且收件箱保留, so that 不自动三路合并毁掉手写段落。
32. As a 使用者, I want 短时撤销仅存在于捕捉端对「刚投递」的反悔（产品既有 B 手感）, so that 误触能救；一旦进入服务端收件箱则走处理环规则。
33. As a 开发者（我自己）, I want 用假 agent 与临时 vault 测编排, so that 不依赖真 Claude 与真 GitHub 也能锁住验收与删除语义。
34. As a 开发者, I want 收件 HTTP 契约可单测, so that 鉴权与「只新建收件箱」不会回退。
35. As a 开发者, I want 回执 schema 稳定, so that 脚本与 skill 有明确交界。
36. As a 开发者, I want skill 明文禁止升格文风与真调研, so that 模型默认行为不漂移出 v1 边界。
37. As a 开发者, I want 配置化日记/想法/收件箱目录名, so that 能贴我真实 vault 而不改核心逻辑。
38. As a 开发者, I want 清晰的实现切片顺序, so that 先干跑编排再接真模型再接 PWA。
39. As a 使用者, I want 处理成功后 PC 拉仓即可读, so that 工作流仍停在我熟悉的 Obsidian。
40. As a 使用者, I want v1 不强迫我接收失败推送, so that 个人工具保持安静（需要时再加通知）。

## Implementation Decisions

### 架构与宿主

- 个人工具；不自研 STT；多用户不做。
- **捕捉端**只向**收件箱**新建文件；**处理端**独占日记/想法正文写入（ADR-0001）。
- 处理环唯一宿主：**VPS**；GitHub **仅 remote**；v1 不用 Actions 跑整理（ADR-0003）。
- 触发：投递成功后唤醒 + cron 托底（默认每 15 分钟，可配）；上传 ≠ 整理。
- 单实例锁（宿主机路径，不进 git）。

### 模块划分（逻辑模块，非文件路径）

1. **Ingest（收件）**  
   - HTTPS `POST` 投递；`Authorization: Bearer <token>`。  
   - Body：`text` 必填；`captured_at` 可选 ISO8601。  
   - 在 vault clone 的收件箱**只新建**带 frontmatter 的 markdown。  
   - 负责该次收件箱变更的 git pull/commit/push（失败则 5xx，客户端可重试，正文不丢）。  
   - 触碰唤醒信号；响应 `{ ok, id, delivered: true }` 明确不是「已整理」。  
   - 不写日记/想法；不调 Claude。

2. **Processor orchestrator（处理编排）**  
   - 控制平面：锁 → pull → 空则早退 → 快照 → 调 agent → 读回执 → **机械验收** →（通过则删 done 收件箱）→ git add/commit/push → 更新 STATE/日志 → 解锁。  
   - **唯一**允许删除成功项收件箱、执行处理轮 git 提交的组件（ADR-0004）。  
   - 依赖可替换：`agentRunner`、`git`、锁、时钟（测试注入 fake）。

3. **Agent skill（Claude Code，工作树写入者）**  
   - 读收件箱（单轮最多 10 条，忽略隔离区）、轻整理、归类、写日记/可选想法/`_staging`/`_processor` 回执与 STATE。  
   - **禁止**：git commit/push/config、删除收件箱文件、白名单外路径、真调研、升格代写。  
   - 只在回执中声明 `done` | `failed` | `quarantine`。

4. **Capture PWA**  
   - 既有 B 在场感；v1 接真 Ingest URL + 本地存 Bearer；成功/失败语义与原型一致。  
   - 不在本 spec 重做视觉，只接契约。

### Vault 约定

- `_inbox/` 收件箱；`_inbox/_quarantine/` 隔离区；`_staging/` 同轮草稿；`_processor/` 含 `STATE.md`、`last-run.json`、可选 run log。  
- 日记目录、想法目录名可配置（默认「日记/」「想法/」）。  
- 收件箱文件名：`YYYYMMDD-HHMMSS-<shortid>.md`；frontmatter 含 id、captured_at、source、attempts。

### 回执契约（编排与 agent 的交界）

- 路径：`_processor/last-run.json`（每轮覆盖或另存历史，编排以本轮文件为准）。  
- 最小字段：`ok`、`round_ended_at`、`processed[]` / `failed[]` / `quarantine[]`；条目含 `inbox`、`status`；`done` 须含 `diary`，可选 `idea`、`needs_research`。  
- 脚本**只信回执 + 工作树/diff**，不信自然语言。

### 写回（ADR-0005）

- 每条 done 至少更新当日日记（时间戳 + 轻整理短段）。  
- 独立想法：新建想法笔记 + 与日记互链；日记侧避免双份全文。  
- 待查：只标记，不写调研结论。  
- 轻整理：去赘词/重复、断句、保语气；禁止升格、扩写、代结论。

### 机械验收（通过才删 inbox 并 commit）

- 变更路径 ∈ 白名单：`_inbox/**`、`_staging/**`、`_processor/**`、日记目录、想法目录。  
- 回执合法；done 的 diary（及声明的 idea）存在；跑前快照中对应 inbox 仍在（由脚本删）。  
- 禁止「回执未授权」的 inbox 删除；发现则失败并尽量恢复。  
- failed 项 inbox 仍在；attempts 递增；≥3 或回执 quarantine → 移入隔离区。  
- 仍有待处理却无 done/failed → 异常轮，不静默成功。  
- 锁占用 → 立即退出；pull/push 冲突 → 中止本轮，inbox 留守。

### 安全

- Ingest token 与模型凭证仅环境变量。  
- Agent 工作目录限于 vault clone。  
- 禁止 force push。  
- max turns / 单轮预算可配。

### 实现语言与部署

- 未钉死语言；须能表达上述两模块与可注入依赖，便于 Seam 测试。  
- 部署目标：使用者已有 VPS；本仓库可先本地 fixture 跑通再上 VPS。

### 建议建造顺序（供后续 to-tickets）

1. 编排 + 假 agent + 临时 vault（Seam 1 全绿）  
2. Ingest HTTP + 只写收件箱（Seam 2 全绿）  
3. 捕捉端接真投递  
4. 真 Claude skill + 回执  
5. cron、锁、STATE、隔离区打磨  
6. 实机连倒 / 失败 / 冲突演习  

## Testing Decisions

### 何谓好测试

- 只断言**对外可见行为**（目录内容、HTTP 状态与 body、是否删除收件箱、commit 后树状态、锁占用时退出），不断言 agent 内部 prompt 或实现私有函数调用顺序。  
- 不访问真 GitHub、真 Anthropic、真手机。  
- 失败信息应能指向契约破坏（例如「done 但缺 diary」「白名单外路径」）。

### Seam 1 — 处理编排（主）

- 模块：Processor orchestrator（含验收、删 done、隔离、锁、早退）。  
- 方式：临时 vault 目录 + fake `agentRunner`（预置工作树与 `last-run.json`）+ fake 或本地 temp git。  
- 必测场景：空收件箱早退；done 成功删除并保留写回；done 缺文件则不删；未授权删除失败；attempts 至隔离；单轮 10 条上限；白名单外失败；锁占用退出。

### Seam 2 — 收件 HTTP

- 模块：Ingest。  
- 方式：测试服务器 + 临时 vault；git 可 fake。  
- 必测场景：缺/错 token → 4xx 且无新文件；合法投递 → 仅新建收件箱文件且 `delivered: true`；空文本拒绝；不创建日记/想法。

### 不做 v1 自动化

- 轻整理文风与分类准确率（样例人工 + skill 迭代）。  
- 端到端真 VPS/Obsidian。  
- 捕捉端视觉回归（已有 prototype）。

### 先验

- 仓库几乎无生产代码与测试；无既有测试 prior art。以本 spec 的 seam 为第一条测试传统。  
- 领域用词以 `CONTEXT.md` 为准。

## Out of Scope

- 真调研执行与有界搜索 Loop  
- 失败/隔离的手机或即时通知  
- 每设备 token、OAuth  
- GitHub Actions 写正文或作主处理端  
- 捕捉端分类 UI、自研 STT、按住说话  
- 多用户、商业化  
- 今日日记内容级三路自动合并  
- Fleet / 多处理环并行 worktree（v1 单实例）  
- 重做捕捉端视觉（只接 Ingest）

## Further Notes

- 术语：口播、收件箱、捕捉端、处理端、处理环、日记、想法、整理、投递、回执、隔离区、待查 —— 见根目录 `CONTEXT.md`。  
- 硬决策：`docs/adr/0001`–`0005`；细则叙事：`temp/tech-design-processor-loop.md`。  
- 「GitHub 触发 Loop」在本产品不成立：VPS 触发，GitHub 收 push。  
- 分类边界的细规则允许实现期改 skill，不阻塞编排与投递。  
- 下一技能：`/to-tickets`，按建造顺序拆 `.scratch/processor-loop/issues/`，票与票之间清上下文再 `/implement`。
