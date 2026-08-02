# 本地手工测试用例

这份清单用于当前 v1 本地联调。执行目标是验证捕捉端、收件箱、Codex 处理环、日记与想法写回、回执验收、失败保护和本地仓库边界。

当前范围说明：

- 本地 vault：`.temp-vaults/codex-e2e-local/vault`
- Git 模式：`VAULT_GIT_MODE=local`
- 本地不会执行 Git、pull、commit、push，也不会修改真实 Obsidian vault。
- 研究 runner 已接入处理环。自动化测试使用假来源验证契约，真实 Codex 研究只通过临时 vault 做人工 smoke test；外部来源、登录状态和模型输出不纳入自动化判定。
- AI 生成的措辞允许有差异，验收以路径、状态、双链、是否保留原文和是否越权为准。

## 一、执行前准备

### 1. 初始化干净测试现场

只在需要清空历史测试数据时执行。它会删除 `.temp-vaults` 下的临时数据，不会删除工具仓代码。

```powershell
Set-Location "D:\前端\需求开发文件夹\口播日记"
$repo = (Resolve-Path '.').Path
$temp = Join-Path $repo '.temp-vaults'
if (Test-Path -LiteralPath $temp) {
  $resolved = (Resolve-Path $temp).Path
  if ($resolved -ne $temp) { throw "临时目录路径校验失败：$resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
npm.cmd run local:setup
```

确认配置指向本地临时 vault：

```powershell
Get-Content -LiteralPath '.\config\local-codex.env' -Encoding UTF8 |
  Where-Object { $_ -match '^(VAULT_PATH|VAULT_GIT_MODE|LOCK_PATH|AGENT_PROVIDER|CODEX_BIN)=' }
```

预期至少包含：

```text
VAULT_PATH=.../.temp-vaults/codex-e2e-local/vault
VAULT_GIT_MODE=local
AGENT_PROVIDER=codex
CODEX_BIN=codex.cmd
```

### 2. 自动检查

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run web:build
```

预期：测试通过，类型检查通过，前端构建通过。

### 3. 启动本地服务

窗口一：

```powershell
npm.cmd run local:ingest
```

窗口二：

```powershell
npm.cmd run local:web
```

浏览器打开 `http://127.0.0.1:4173/`。本地 ingest 成功后会自动排队处理，不需要同时手动启动 `local:processor`。

基础健康检查：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8788/health'
```

预期：返回 `ok: true`。

### 4. 常用检查变量

```powershell
$VaultPath = "D:\前端\需求开发文件夹\口播日记\.temp-vaults\codex-e2e-local\vault"
$DiaryRoot = Join-Path $VaultPath '生活\日子一天天过去'
$IdeasRoot = Join-Path $VaultPath 'Yan帳\想法'
$ResearchRoot = Join-Path $VaultPath 'Yan帳\研究'
$InboxRoot = Join-Path $VaultPath '_inbox'
```

查看本轮回执：

```powershell
$receipt = Join-Path $VaultPath '_processor\last-run.json'
if (Test-Path -LiteralPath $receipt) {
  Get-Content -LiteralPath $receipt -Encoding UTF8 -Raw |
    ConvertFrom-Json |
    ConvertTo-Json -Depth 10
}
```

## 二、基础环境用例

### L-01 干净初始现场

步骤：

1. 执行初始化现场命令。
2. 检查 `.temp-vaults`。
3. 检查 vault 是否存在 `.git`。

预期：

- 只存在 `codex-e2e-local/vault`。
- 存在 `_inbox`、`_processor`、`_staging`、`Yan帳/想法`、`Yan帳/研究` 和日记根目录。
- 想法、研究、日记正文均为空。
- vault 内不存在 `.git`。
- 不存在历史 `practice` 或 `practice.git`。

结果：`[ ] 通过  [ ] 失败`

### L-02 空收件箱早退

步骤：

```powershell
npm.cmd run local:processor
```

预期：

- 返回 `status: "empty"`。
- `agentInvoked` 为 `false`。
- 日志出现 `processor.inbox_scanned`，`pending` 为 `0`。
- 不创建日记正文、想法文件或研究简报。
- 锁被正常释放。

结果：`[ ] 通过  [ ] 失败`

### L-03 本地 Git 边界

步骤：

1. 执行一次成功投递并等待处理完成。
2. 检查工具仓和临时 vault。

```powershell
git status --short --branch
Test-Path -LiteralPath (Join-Path $VaultPath '.git')
```

预期：

- 工具仓状态中不出现 `.temp-vaults` 内部文件路径；测试文档或研究 skill 的预期改动可以保留。
- 临时 vault 的 `.git` 检查结果为 `False`。
- 本地日志没有 `pull`、`commit`、`push`。

结果：`[ ] 通过  [ ] 失败`

## 三、捕捉端与收件用例

### L-04 页面初始状态

步骤：

1. 打开捕捉页面。
2. 不输入内容，观察输入框和投递按钮。

预期：

- 输入框自动获得焦点。
- 空内容时投递按钮不可用。
- 页面显示今天已投数量为 `0`。
- 调试面板可以查看当前配置状态。

结果：`[ ] 通过  [ ] 失败`

### L-05 正常投递一条口播

输入：

```text
今天下午三点开始整理接口，先把收件箱写入和处理环的日志看明白。
```

步骤：

1. 输入文本并点击送进收件箱。
2. 观察页面和 ingest 窗口。
3. 等待处理环结束。

预期：

- 页面先显示投递成功，响应语义为 `delivered: true`。
- 输入框清空并重新获得焦点。
- 今日已投数量增加 1。
- 日志依次能看到投递、排队、加锁、扫描、agent 启动、回执验收和轮次结束。
- `_inbox` 条目处理成功后被脚本删除。
- 当日日记出现一条轻整理内容。
- `last-run.json` 中有对应 `done` 项和合法 `diary` 路径。
- 页面显示的投递成功只代表进入收件箱，不把它误认为研究完成。

结果：`[ ] 通过  [ ] 失败`

### L-06 连续投递三条

连续投递以下三条，不等待页面停留：

```text
上午完成了一个小接口，下午准备补测试。
午饭后注意力下降，决定把复杂任务拆成更小的步骤。
晚上把本地配置重新检查了一遍，暂时没有发现路径混用。
```

预期：

- 三条都返回 `delivered: true`。
- 三个收件箱 id 唯一。
- 页面历史显示三条，正文顺序和投递顺序一致。
- 同一天只使用一篇当日日记，内容有三段或三个时间点。
- 不产生三篇同日新日记。
- 工具仓没有被写入口播正文。

结果：`[ ] 通过  [ ] 失败`

### L-07 空文本和空白文本

步骤：

1. 页面输入空格和换行。
2. 确认按钮不可用。
3. 可选地使用 API 发送 `{"text":"   "}`。

预期：

- 页面不会发起正常投递。
- API 返回 400，错误为 `text empty`。
- `_inbox` 不增加文件。

结果：`[ ] 通过  [ ] 失败`

### L-08 强制失败时保留正文

步骤：

1. 打开页面的调试面板。
2. 勾选下次提交强制失败。
3. 输入：`这条用于验证失败时不能丢稿。`
4. 点击投递。

预期：

- 页面显示失败提示。
- 正文仍保留在输入框。
- 今日已投数量不增加。
- 本次强制失败不发 HTTP 请求。
- `_inbox` 不增加文件。

结果：`[ ] 通过  [ ] 失败`

### L-09 错误 Bearer token

步骤：

1. 在页面设置中把 token 临时改成错误值。
2. 输入：`验证错误 token 时保留正文。`
3. 投递。
4. 恢复正确 token。

预期：

- API 返回 401。
- 页面显示失败原因。
- 输入框正文保留。
- 页面本地历史不增加。
- `_inbox` 不增加文件。

结果：`[ ] 通过  [ ] 失败`

### L-10 投递撤回回填

步骤：

1. 成功投递一条内容。
2. 在撤回提示消失前点击正文回填。

预期：

- 正文回到输入框。
- 页面不会自动再次投递。
- 服务端已创建的条目仍按处理环生命周期处理。若处理已经完成，允许收件箱中找不到原条目。
- 再次点击投递会创建新的 id，不覆盖旧条目。

结果：`[ ] 通过  [ ] 失败`

### L-11 API 鉴权、JSON 和时间字段

使用 PowerShell 或 API 工具分别发送以下请求：

| 场景 | 预期状态 | 预期结果 |
| --- | ---: | --- |
| 缺少 Authorization | 401 | 不写入 inbox |
| 错误 Bearer | 401 | 不写入 inbox |
| 非 JSON body | 400 | 不写入 inbox |
| 缺少 `text` | 400 | 不写入 inbox |
| `text` 非字符串 | 400 | 不写入 inbox |
| 非法 `captured_at` | 400 | 不写入 inbox |
| 合法 ISO 时间 | 200 | 回执含 `delivered: true` |

合法请求示例：

```powershell
$body = @{ text = 'API 合法投递测试'; captured_at = '2026-07-31T12:00:00+08:00' } |
  ConvertTo-Json
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8788/ingest' `
  -Method Post `
  -Headers @{ Authorization = 'Bearer local-test-token' } `
  -ContentType 'application/json' `
  -Body $body
```

结果：`[ ] 通过  [ ] 失败`

## 四、日记、想法和待查用例

### L-12 纯日常内容只进入日记

输入：

```text
今天下午三点去楼下拿了快递，回来继续写接口，五点半结束工作，晚上正常吃饭休息。
```

预期：

- 当日日记增加轻整理段落。
- 不创建 `Yan帳/想法` 文件。
- 不创建 `Yan帳/研究` 文件。
- 原意、时间和语气没有被扩写成新的结论。

结果：`[ ] 通过  [ ] 失败`

### L-13 独立想法写入 Yan帳/想法

输入：

```text
我想做一个很小的个人工具，核心只保留快速投递、AI 轻整理和写回 Obsidian。标签、搜索、提醒以后再说，先保证这三个动作稳定。
```

预期：

- 当日日记仍然更新。
- 创建一条独立想法文件。
- 想法文件直接位于 `Yan帳/想法/` 下一层。
- 日记侧保留时间戳、简短钩子和想法 wikilink。
- 想法侧保留轻整理后的主要内容，并回链当日日记。
- 日记不重复粘贴完整想法全文。
- 不创建日记树下的 `想法` 子目录。

结果：`[ ] 通过  [ ] 失败`

### L-14 想法与待查同时存在

输入：

```text
今天开会时突然想到，如果每天的口播都先进入一个临时收件箱，再由 AI 判断应该放进当天日记，还是抽成一条可以长期回看的想法，可能比我现在手动整理更容易坚持。

我想把这个流程做成一个很小的个人工具，核心只保留三个动作：快速投递、AI 轻整理、写回 Obsidian。以后如果要加标签、搜索、提醒，也应该建立在这些基础流程稳定之后。

不过我还不清楚 Obsidian 的 wikilink 在不同目录层级下是否都能稳定跳转，这个需要之后查一下，暂时不要假设答案。
```

预期：

- 当日日记有处理结果。
- 独立产品想法可以进入 `Yan帳/想法/`，并和日记双链。
- `needs_research` 可以被标记，且要说明待查内容。
- 内容整理阶段先登记研究任务，研究阶段随后尝试写入 `Yan帳/研究/`；成功时必须完成证据和双链验收，失败时保留 `needs_research: true`。
- 当前处理环不写未经验证的 wikilink 结论。
- `Yan帳/研究/` 中不得出现没有证据验收的确定性简报。

结果：`[ ] 通过  [ ] 失败`

### L-15 同一日合并并保留旧日记

准备：先在当天日记中写入一段人工内容，例如：

```text
## 人工内容

这段文字用于验证处理环不会覆盖已有日记。
```

步骤：

1. 投递一条普通口播。
2. 等待处理完成。
3. 检查当天日记。

预期：

- 人工内容仍然存在，顺序和原有段落没有被删除。
- 新内容追加到同一日记。
- 不创建平行的口播日记目录。

结果：`[ ] 通过  [ ] 失败`

### L-16 想法标题冲突

步骤：

1. 先完成 L-13，记录生成的想法文件名。
2. 再次投递含义相同或标题高度相似的独立想法。
3. 等待处理完成。

预期：

- 第一份想法正文不被覆盖。
- 新内容使用新的合法文件名，或处理环明确报告无法安全合并。
- 两条日记链接不能静默指向错误内容。
- 如果同一轮因复用同一 `idea` 路径导致验收失败，收件箱应保留，并在 `STATE.md` 记录原因，此结果需要记录为缺陷候选。

结果：`[ ] 通过  [ ] 失败`

### L-17 研究标记不伪造研究

输入：

```text
我想知道用手机侧面视频分析深蹲动作是否可靠，还需要查有哪些姿态估计模型和训练数据，暂时不要直接下结论。
```

预期：

- 日记或想法中可以记录待查问题。
- 回执中可以出现 `needs_research: true`。
- 研究阶段成功时生成带证据的研究简报；来源受限或证据不足时保留 `needs_research: true`，不生成无来源确定性结论。
- 内容中不出现没有来源的技术结论、论文链接或假数据。
- 原始收件箱只在合法验收后由脚本删除。

结果：`[ ] 通过  [ ] 失败`

### L-18 复杂口播保留多条语义

输入一段同时包含事实、感受、想法和后续问题的长文本，至少包含 3 个自然段。

预期：

- AI 做断句、去明显重复和轻整理。
- 事实、个人判断和待查问题没有被混成一个结论。
- 日记侧保留时间轴。
- 可独立回看的内容才进入想法文件。
- 待查内容只标记，不替用户完成研究。

结果：`[ ] 通过  [ ] 失败`

## 五、处理环与保护用例

### L-19 并发触发与单实例锁

准备一条待处理口播，让处理环开始运行后，立即在另一个窗口执行：

```powershell
npm.cmd run local:processor
```

预期：

- 同一时间最多一个处理轮真正调用 agent。
- 另一个进程返回 `status: "locked"`，或日志出现 `processor.round_locked`。
- 不出现两份重复想法。
- 不出现日记双写或回执互相覆盖。

结果：`[ ] 通过  [ ] 失败`

### L-20 处理上限

此用例需要暂时停止自动 ingest，再向 `_inbox` 放入 11 条合法 Markdown 收件文件。连续通过页面投递会触发多轮处理，不能稳定形成同一轮的 11 条快照。

可用下面的 PowerShell 生成 11 条测试收件：

```powershell
for ($i = 1; $i -le 11; $i++) {
  $id = "manual-{0:D2}" -f $i
  $file = Join-Path $InboxRoot "$id.md"
  $content = @"
---
id: $id
captured_at: 2026-07-31T12:00:00+08:00
source: manual-test
attempts: 0
---

第 $i 条单轮上限测试内容。
"@
  Set-Content -LiteralPath $file -Value $content -Encoding UTF8
}
npm.cmd run local:processor
```

预期：

- 单轮最多处理 `MAX_PER_ROUND=10` 条。
- 超过上限的条目保留在 `_inbox`，留待下一轮。
- 当前轮回执只交代本轮快照中的条目。
- 不处理 `_inbox/_quarantine/` 中的文件。

结果：`[ ] 通过  [ ] 失败`

### L-21 回执与路径验收

每轮完成后检查：

```powershell
Get-Content -LiteralPath (Join-Path $VaultPath '_processor\last-run.json') -Encoding UTF8 -Raw
Get-Content -LiteralPath (Join-Path $VaultPath '_processor\STATE.md') -Encoding UTF8 -Raw
```

预期：

- `last-run.json` 可以解析。
- 每条本轮 inbox 只出现在 `processed`、`failed` 或 `quarantine` 其中一个数组。
- `done` 有真实存在的 `diary`。
- 声明 `idea` 时，文件真实存在于 `Yan帳/想法/` 下一层。
- 研究路径即使被声明，也不能越过配置的 `Yan帳/研究/` 白名单。
- `STATE.md` 有更新时间、状态和原因或结果。

结果：`[ ] 通过  [ ] 失败`

### L-22 失败保留与隔离

此用例优先使用自动化测试验证，手工执行需要准备一个可控的失败 agent 或损坏回执，不建议直接破坏真实配置。

预期：

- agent 失败或回执验收失败时，原 inbox 不丢失。
- 失败次数递增。
- 达到 `MAX_ATTEMPTS=3` 后进入 `_inbox/_quarantine/`。
- 隔离条目不再被普通处理轮扫描。
- `STATE.md` 记录失败原因。

对应自动化覆盖：`src/processor/orchestrator.test.ts` 的失败累计、回执缺 diary、未授权删除和白名单外变更用例。

结果：`[ ] 自动通过  [ ] 手工通过  [ ] 未执行`

### L-23 日记树和想法路径安全

此用例以自动化测试为主，手工检查写回结果：

- 日记路径形如 `生活/日子一天天过去/YYYY/YYYY-MM/YYYY-MM-DD.md`。
- 想法路径形如 `Yan帳/想法/短标题.md`。
- 研究路径形如 `Yan帳/研究/短标题.md`。
- 不出现 `生活/.../Yan帳/想法/`。
- 不出现 `Yan帳/想法/子目录/文件.md`。
- 不出现按年、按月嵌套的想法或研究文件。
- 不写入工具仓的 `src`、`config`、`skills` 或用户目录。

结果：`[ ] 通过  [ ] 失败`

### L-24 本地日志可排查

执行一条正常投递和一条失败投递，分别观察 ingest 和 processor 窗口。

预期至少能定位以下事件：

```text
ingest.delivered
processor.queue_enqueued
lock.acquired
processor.inbox_scanned
agent.started
agent.output
agent.exited
processor.acceptance
processor.round_finished
```

失败时应能看到 agent 启动失败、验收失败或锁占用原因，不能只返回一个无法定位的 `failed`。

结果：`[ ] 通过  [ ] 失败`

## 六、真实研究 runner 手工 smoke test

自动化测试不访问真实来源或 Codex。以下用例只在临时 vault 中执行，结果需要人工检查来源、证据边界、状态和双向链接。

执行前确认 `config/local-codex.env` 中的 `VAULT_PATH` 指向临时 vault、`VAULT_GIT_MODE=local`，并具备有效的 Codex 登录状态。`RESEARCH_BIN`、`RESEARCH_MODEL`、`RESEARCH_REASONING_EFFORT` 和 `RESEARCH_TIMEOUT_MS` 可显式覆盖默认值。

执行命令：

```powershell
npm.cmd run local:setup
npm.cmd run local:processor
```

处理完一条带待查问题的口播后，检查 `_processor/research-tasks.json`、来源笔记和 `Yan帳/研究/`。失败或访问受限时，任务必须为 `partial` 或 `blocked`，来源仍保留 `needs_research: true`。

### R-01 产品想法可行性研究

输入一个想法，例如：

```text
我想开发一个用 AI 分析自己撸铁三大项视频的系统，用来判断动作完成度、发现可观察的动作异常、制定改进计划，并了解受伤风险。
```

预期：

- 从想法拆出主问题、子问题和个人 MVP。
- 优先使用国外和国际来源、论文、官方模型资料和运动生物力学资料。
- 分开记录视频能观察到的动作指标、无法从视频可靠判断的伤病结论。
- 研究杠铃追踪、姿态估计、动作分段、个人基线和训练数据。
- 包含反方观点、数据缺口、误报漏报和失败条件。
- 写入 `Yan帳/研究/`，与来源想法双向链接。

### R-02 研究结果产生新想法

研究过程中发现新的产品方向、实验假设或训练方法时，预期：

- 保留在研究简报的后续想法区域。
- 不覆盖原研究结论。
- 不自动把未经确认的内容伪装成正式想法。
- 通过 `origin_brief` 或 wikilink 回链研究简报。

### R-03 高风险主题

涉及健康、伤病、法律、财务或安全的研究，预期：

- 只给出资料和证据边界。
- 不生成诊断、伤病概率或无背景的个人化指令。
- 标记适用范围、未知点和需要专业判断的部分。

## 七、自动化覆盖索引

手工执行前，可以用下面命令确认基础契约仍然通过：

```powershell
npm.cmd test
```

自动化已覆盖的重点包括：

- 收件鉴权、空文本、CORS 和本地 adapter：`src/ingest/server.test.ts`
- 空收件箱、成功删除、失败保留、隔离、上限、白名单、锁：`src/processor/orchestrator.test.ts`
- 回执重复 inbox、重复 idea、越界 inbox、agent 修改 inbox：`src/processor/accept.test.ts`
- 唤醒和并发串行：`src/processor/wake.test.ts`
- 本地 Git 模式和目录配置：`src/env.test.ts`、`src/git/local-vault.test.ts`
- Codex prompt 路径和 Windows 参数：`src/agent/cli-runner.test.ts`

## 八、执行记录

每次完整测试填写一次：

```text
日期：
操作者：
Node / Codex 版本：
使用模型：
配置文件：config/local-codex.env
VAULT_PATH：

通过用例：
失败用例：
未执行用例：
发现的问题：
相关日志时间：
是否清理临时 vault：
```
