# 技术方案：口播日记处理环（v1）

> 状态：grill 已确认，可实现  
> 日期：2026-07-29  
> 相关：`CONTEXT.md`、`docs/adr/0001`–`0005`、`temp/research-loop-engineering.md`

## 1. 目标与非目标

### 目标

个人工具：手机捕捉口播 → 收件箱 → **VPS 上的处理环**自动轻整理并写入 Obsidian vault（日记为轴，可选抽出想法）→ PC / 其它端经 git 看见结果。  
人不手动点「处理」；人定边界、看 STATE / 隔离区、偶尔改 skill。

### 非目标（v1）

- 真调研执行（只打 `needs_research` / 待查）
- 捕捉端手动选「日记 / 想法」
- GitHub Actions 跑整理或写正文
- 多用户、自研 STT、失败推送通知
- 内容级三路合并今日日记（冲突则停，人收）

## 2. 已锁定决策摘要

| 项 | 结论 |
|----|------|
| 投递 | PWA → VPS 收件接口 → `_inbox/` 只新建 → git commit/push |
| 鉴权 | HTTPS + 共享 Bearer token |
| 处理时机 | 投递后唤醒 + cron 托底；上传 ≠ 整理 |
| 宿主 | **仅 VPS**；GitHub = remote only |
| 草稿 | `_staging/` 同轮内部 staging，人默认不审 |
| 写回 | 日记为轴 + 可选想法笔记；防双份全文 |
| 分类 | 模型分析；可双链 |
| 整理 | 轻整理（去赘词/重复、保语气） |
| 执行形态 | Claude Code 主写工作树（B2）+ 全套护栏 |
| git / 删收件箱 | **脚本**：验收通过后统一删 done 项，再 commit/push |
| 失败 | 收件箱留守；同条 ≤3 次；超限隔离区；单轮 ≤10 条；无通知 |
| 调研 | 只打标，v1.5 再做 |

## 3. 逻辑架构

```text
┌──────────────┐  HTTPS+Bearer   ┌─────────────────────────────┐
│ 捕捉端 PWA   │ ───────────────▶│ VPS                         │
│ （B 在场感）  │   投递口播文本   │  收件接口（只新建 _inbox）    │
└──────────────┘                 │  唤醒 flag / 队列            │
                                 │  cron 托底                   │
                                 │  处理编排脚本（单实例锁）      │
                                 │  Claude Code（skill，改文件） │
                                 │  vault git clone（权威写者）  │
                                 └──────────────┬──────────────┘
                                                │ git push
                                                ▼
                                 ┌─────────────────────────────┐
                                 │ GitHub（仅 remote）           │
                                 └──────────────┬──────────────┘
                                                │ pull
                                 ┌──────────────▼──────────────┐
                                 │ PC Obsidian Git / 其它端      │
                                 └─────────────────────────────┘
```

**GitHub 不触发处理环。**  
触发源只有：VPS 收件接口唤醒、VPS cron。  
push 到 GitHub 是处理结果的发布，不是 Loop 的输入。

## 4. Vault 目录约定

```text
_inbox/                 # 收件箱：仅新建；成功处理后由脚本删除
_inbox/_quarantine/     # 隔离区：超次失败，不再自动处理
_staging/               # 同轮内部草稿；轮末应空或可忽略提交
_processor/
  STATE.md              # 环状态（进 git，PC 可见）
  loop-run-log.md       # 追加式跑次日志（可选）
  last-run.json         # 本轮回执（AI 写，脚本读）
  runs/                 # 可选：历史回执
日记/                   # 按日一篇（若 vault 已有实名，配置替换）
想法/                   # 独立想法笔记
```

- 锁文件：VPS 本地路径（如 `/run/koubo-processor.lock`），**不进 git**
- 收件箱文件名：`YYYYMMDD-HHMMSS-<shortid>.md`（只新建，避免改名冲突）

### 收件箱条目建议形态

```markdown
---
id: 20260729-153012-abc
captured_at: 2026-07-29T15:30:12+08:00
source: capture-pwa
attempts: 0
---

（口播原文）
```

## 5. 组件设计

### 5.1 收件接口（VPS）

- `POST /ingest`（路径可配置）
- Header：`Authorization: Bearer <token>`
- Body：`{ "text": "…", "captured_at"?: ISO8601 }`
- 行为：
  1. 校验 token、非空文本、长度上限
  2. 在 vault clone 的 `_inbox/` **新建**文件
  3. `git pull --rebase`（失败则 5xx，正文不丢在客户端重试）
  4. commit 仅含该收件箱文件（或短时间 batch，v1 可一条一 commit）
  5. `git push`
  6. 触碰唤醒（写 flag 或 `systemctl start koubo-processor.service --no-block`）
  7. 返回 `{ "ok": true, "id": "…", "delivered": true }`  
     **不表示已整理**
- 不写日记/想法；不调 Claude

### 5.2 处理编排脚本（VPS，唯一控制平面）

职责顺序：

```text
1. 尝试获取单实例锁（失败则退出）
2. cd vault && git pull --rebase（失败：记 STATE，解锁退出）
3. 若 _inbox 无待处理文件（忽略 _quarantine）：更新 STATE 后退出
4. 快照：inbox 列表、HEAD rev
5. 调用 Claude Code 非交互跑「处理收件箱」skill（见 5.3）
6. 读 _processor/last-run.json 回执
7. 机械验收（见 6）
8. 验收通过：按回执 done 列表删除 _inbox 对应文件；清理约定 _staging
9. git add 白名单路径；commit；push
10. 追加 loop-run-log；更新 STATE；释放锁
```

任一步失败：不删收件箱（除非已在隔离流程中移动）；不 push 正文成功态；写 STATE error。

**默认 cron**：每 15 分钟；与唤醒可重叠，靠锁串行。

### 5.3 Claude Code skill（Agent 主写工作树）

工作目录：仅 vault clone。

**允许做**

- 读 `_inbox/` 待处理项（单轮最多 10 条，按时间排序）
- 写/改 `_staging/`、`日记/`、`想法/`、`_processor/STATE.md`、`_processor/last-run.json`
- 轻整理 + 归类 + 打待查标记
- 按写回规则改 markdown

**禁止做**

- `git commit` / `git push` / `git config` / force push
- 删除 `_inbox/` 文件（只在回执里标 `done` / `failed` / `quarantine`）
- 触碰白名单外路径
- 执行真调研（搜索外网写「伪答案」）
- 升格文风、扩写未说内容

**回执 `last-run.json` 最小 schema**

```json
{
  "ok": true,
  "round_ended_at": "ISO8601",
  "processed": [
    {
      "inbox": "_inbox/20260729-153012-abc.md",
      "status": "done",
      "diary": "日记/2026-07-29.md",
      "idea": "想法/某短标题.md",
      "needs_research": false,
      "notes": ""
    }
  ],
  "failed": [
    {
      "inbox": "_inbox/….md",
      "status": "failed",
      "error": "…",
      "attempts_observed": 1
    }
  ],
  "quarantine": []
}
```

`status`：`done` | `failed` | `quarantine`  
脚本**只相信回执 + diff 交叉验证**，不相信模型的自然语言自称。

### 5.4 写回规则（日记为轴）

对每条 `done`：

1. **当日日记必更新**  
   - 无则新建按日文件  
   - 有则在约定区域追加：时间戳 + 轻整理后的短段  
   - 若有独立想法：日记内以 `[[想法/…]]` 链接为主，避免日记与想法双份全文
2. **可选想法笔记**  
   - 模型认为是独立灵感时：`想法/` 下新建（短标题 + 全文 + 链回日记）  
   - `needs_research: true` 时 frontmatter / 标签标待查，**不写调研结论**
3. **轻整理边界**  
   - 允许：去口头赘词与明显重复、断句分段、少量标点、极长时可加小标题  
   - 禁止：升格文风、扩写论据、代下结论、纠正观点、翻译腔

分类边界的细规则（何种算想法）实现期用 skill 迭代，本方案只钉「模型分析 + 上述写回形状」。

## 6. 机械验收（脚本 = 最小 Checker）

全部通过才删收件箱并 commit：

1. **路径白名单**：`git status` 变更仅限  
   `_inbox/**`、`_staging/**`、`_processor/**`、`日记/**`、`想法/**`
2. **回执存在且 JSON 合法**；`processed/failed/quarantine` 列表路径落在 `_inbox/`
3. **done 一致性**  
   - 每个 `done` 的 `diary` 文件存在  
   - 若声明 `idea`，文件存在  
   - 跑前快照里该 inbox 文件仍在（尚未删，由脚本删）
4. **未授权删除**：diff 中不得出现「回执未声明」的 inbox 删除（Agent 若误删 → 本轮失败，尝试从 HEAD 恢复 inbox）
5. **失败项**：`failed` 的 inbox 仍存在；`attempts` frontmatter +1（脚本或约定由 AI 写，脚本核对）
6. **隔离**：`attempts >= 3` 或回执 `quarantine` → 脚本移入 `_inbox/_quarantine/`，记 STATE
7. **空成功**：无 done/failed 且 inbox 仍有文件 → 视为异常轮，不静默成功

## 7. git 节奏与冲突

| 动作 | 谁 | commit 内容 |
|------|----|-------------|
| 投递 | 收件接口 | 仅新 `_inbox/*` |
| 处理成功 | 编排脚本 | 日记/想法/`_processor` + 删除已 done 的 inbox + 可能的 quarantine 移动 |
| 处理失败 | 编排脚本 | 通常可只更新 `STATE` / attempts（可选）；**不删**失败 inbox |

- 每次写前：`git pull --rebase`
- 禁止 force push
- 与 PC 同改今日日记导致冲突：本轮中止，STATE 记冲突；收件箱保留。人很少晚上写日记，概率可接受。
- Obsidian Git 继续 pull/commit/push 其它笔记； ass 约定尽量不手改「尚未消化完的当日日记」热点段落。

## 8. 处理环单轮时序（成功路径）

```text
捕捉端 ──POST /ingest──▶ 收件接口 ──新建 _inbox──▶ commit/push ──唤醒──▶ 返回已投递
                                                                    │
cron 可同时尝试，锁串行 ◀────────────────────────────────────────────┘
                                                                    ▼
编排脚本：pull → 锁 → 快照 → claude skill
                                                                    ▼
Claude：读 inbox →（可选 staging）→ 写日记/想法/STATE/回执（不删 inbox、不 git）
                                                                    ▼
脚本：验收 → rm done 的 inbox → add → commit → push → 日志 → 解锁
                                                                    ▼
PC Obsidian Git pull → 用户阅读
```

## 9. 失败与重试

| 情况 | 行为 |
|------|------|
| 模型超时 / 非结构化回执 | 不删 inbox；attempts+1；STATE error |
| 验收失败 | 同；必要时还原误删 |
| 同条 attempts≥3 | 移入 `_inbox/_quarantine/`，停止自动啃 |
| git pull/push 冲突 | 整轮退出，下轮再来 |
| 锁占用 | 直接退出 |
| 单轮已处理满 10 条 | 剩余留 inbox 下轮 |
| VPS 宕机 | 未 push 的本地变更以磁盘为准；重启后 cron/唤醒继续；inbox 不丢（已在 git 的投递更安全） |

v1 **不**做手机推送；PC 打开 vault 看 `_processor/STATE.md` 与隔离区。

## 10. 安全护栏（B2 必带）

1. Claude 工作目录 = vault clone  
2. 路径 allowlist 同验收白名单  
3. 单实例锁  
4. 失败不删收件箱原文  
5. 禁止 force push / 改 git config / 提交密钥文件  
6. max turns + 单轮时间或费用预算（实现时写入配置）  
7. skill 钉死轻整理与只打标调研  
8. 脚本机械验收；git 只归脚本  
9. 收件 token 与模型凭证仅 VPS 环境变量，不进 vault git  

## 11. 配置项（实现期）

```text
VAULT_PATH=
INGEST_TOKEN=
GIT_REMOTE=origin
INBOX_DIR=_inbox
DIARY_DIR=日记
IDEAS_DIR=想法
CRON_SCHEDULE=*/15 * * * *
MAX_PER_ROUND=10
MAX_ATTEMPTS=3
CLAUDE_BIN=claude
PROCESSOR_SKILL=处理收件箱   # 名称以仓库 skill 为准
```

模型账号形态（API key / 订阅登录）在 VPS 部署时选定，不进本决策文档核心。

## 12. v1 实现切片（建议顺序）

1. **目录 + 本地脚本干跑**：假回执、验收、删 inbox、commit（不含 Claude）  
2. **收件接口 + Bearer + 只写 inbox + push**  
3. **捕捉端 PWA 接真投递**（沿用 B 手感）  
4. **Claude skill + 回执 schema + 编排接通**  
5. **cron + 锁 + STATE/隔离区**  
6. **实机：连倒多条、故意失败、冲突演习**

## 13. v1.5 以外（明示）

- 待查条目的真调研 Loop（有界搜索、必须带链接、失败降级）  
- 失败/隔离通知（ntfy 等）  
- 设备级 token  
- GitHub Actions 仅通知（仍不写正文）  
- 更细的想法分类规则产品化  

## 14. 与 Loop Engineering 的对应

| 积木 | 本项目落点 |
|------|------------|
| Scheduling | 投递唤醒 + cron |
| Skills | Claude「处理收件箱」skill |
| State | `_processor/STATE.md` + 回执 |
| Maker/Checker | Claude 写树 / 脚本验收 |
| Worktree | v1 单实例可不做；并行后置 |
| MCP | v1 不需要 |
| GitHub Actions | 不用 |

职责一句话（处理环）：

> 观察收件箱；有则轻整理并写入日记（及可选想法）；通过脚本验收后清理已处理项；无则安静结束本轮。

## 15. 待实现期确认（不阻塞架构）

- 日记/想法在真实 vault 中的目录实名  
- cron 15 分钟是否改为 5/30  
- Claude Code 在 VPS 的登录与 `claude -p`（或等价非交互）确切旗标  
- 收件接口用什么最小栈（如 Go/Node/Caddy+cgi），任选  

---

**文档结束。** 实现前若改「git 归脚本 / 仅 VPS / 日记为轴」任一条，先改 ADR 再改代码。
