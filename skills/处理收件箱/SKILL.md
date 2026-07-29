---
name: 处理收件箱
description: 读取 vault 收件箱口播，轻整理后以日记为轴写回，可选抽出想法并互链，写出机器可读回执。由编排脚本调用；禁止 git 与删除收件箱。
---

# 处理收件箱

你是口播日记 **处理端** 的工作树写入者。编排脚本已经：拿到单实例锁、pull、列出本轮待处理收件箱。你只负责读口播、轻整理、写日记/可选想法、写回执。

## 允许

- 读 `_inbox/` 下本轮待处理 markdown（忽略 `_inbox/_quarantine/`）
- 写/改：
  - `日记/`（目录名以仓库配置为准，可能是其它中文名）
  - `想法/`
  - `_staging/`（同轮草稿，轮末尽量干净）
  - `_processor/STATE.md`
  - `_processor/last-run.json`（**必须**）
- 轻整理：去口头赘词与明显重复、断句分段、少量标点；极长时可加小标题
- 归类：日记为轴；独立灵感可新建想法笔记并与日记互链
- 待查：只打标（frontmatter / 标签 / `needs_research: true`），**不写调研结论**

## 禁止

- `git commit` / `git push` / `git config` / force push / 改 remote
- **删除** `_inbox/` 文件（包括 done 项）；删除只由编排脚本在验收通过后执行
- 触碰白名单外路径（家目录、密钥、`.env`、此 skill 以外的项目文件等）
- 真调研、外网搜索后写「伪答案」
- 升格文风、扩写未说内容、代下结论、纠正作者观点、翻译腔润色

## 写回形状（日记为轴）

对每条准备标为 `done` 的口播：

1. **当日日记必更新**
   - 无则新建按日文件（文件名跟随 vault 既有习惯，常见 `YYYY-MM-DD.md`）
   - 有则在约定区域追加：时间戳 + 轻整理后的短段
   - 若抽出独立想法：日记侧以 `[[想法/…]]` 链接为主，避免双份全文
2. **可选想法笔记**
   - 仅当内容是可脱离「今天」单独检索的灵感
   - 短标题 + 全文 + 链回当日日记
3. **失败**
   - 无法安全处理时标 `failed`，inbox 文件保持不动
4. **隔离意向**
   - 若明显毒数据/反复无法处理，可标 `quarantine`（脚本会移动）；不要自己移动文件

## 回执（必须）

路径：`_processor/last-run.json`

```json
{
  "ok": true,
  "round_ended_at": "ISO8601",
  "processed": [
    {
      "inbox": "_inbox/YYYYMMDD-HHMMSS-id.md",
      "status": "done",
      "diary": "日记/YYYY-MM-DD.md",
      "idea": "想法/短标题.md",
      "needs_research": false,
      "notes": ""
    }
  ],
  "failed": [
    {
      "inbox": "_inbox/….md",
      "status": "failed",
      "error": "简短原因",
      "attempts_observed": 1
    }
  ],
  "quarantine": []
}
```

- `status` 只有：`done` | `failed` | `quarantine`
- 脚本**只信回执 + 工作树**，不信你的自然语言自称
- `done` 必须有已存在的 `diary`；声明了 `idea` 则文件必须存在
- 不要在回执里把未处理的 inbox 标成 done

## 单轮

- 编排可能只传入最多 10 条；不要擅自扫隔离区
- 做完就停，不要开启无边界的「再优化一遍」

## 口气

整理后仍应像使用者本人随口说的话，只是更干净。不要写成公众号、日报或助手总结。
