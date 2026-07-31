# 真实 vault 路径约定（口播环）

对应 ADR-0006。只描述**处理环允许写的位置**；不要求改动 vault 里历史笔记正文。

## 部署时建议新建（空目录即可）

在 vault 根：

```text
_inbox/
_inbox/_quarantine/
_staging/
_processor/
想法/                 # 若尚不存在
.claude/skills/处理收件箱/SKILL.md  # CLI agent 的只读 skill 基线
```

日记树一般已存在：

```text
生活/日子一天天过去/
  YYYY/
    YYYY-MM/
      YYYY-MM-DD.md
```

## 写回规则摘要

| 类型 | 路径 | 规则 |
|------|------|------|
| 日记 | `生活/日子一天天过去/YYYY/YYYY-MM/YYYY-MM-DD.md` | 按日一篇，追加；新建月目录名 `YYYY-MM`（无前导空格） |
| 想法 | `想法/短标题.md` | 一条一文件；扁平；v1 不按年归档 |
| 待查 | frontmatter / 回执 `needs_research` | 只标不查 |
| 收件 | `_inbox/*.md` | 只新建；成功后由脚本删 |

## 环境变量

```env
DIARY_DIR=生活/日子一天天过去
IDEAS_DIR=想法
INBOX_DIR=_inbox
```

`DIARY_DIR` 是**前缀**：白名单放行该前缀下所有子路径，便于年/月分层。

## 明确不写

- `吾志/`、`wolai-app/`、`学习/`、`工作/`、`投资/` 等
- 想法按年自动归档目录（v1 无）
- 开放主题 tag 体系

`.claude/skills/处理收件箱/SKILL.md` 是部署基线文件，不由 agent 在处理轮中修改。工具仓中的同名 skill 更新后，先同步到 vault 基线并单独提交，再运行处理环。

## 与本机路径

开发机 vault 示例：`E:\日记`（仅作你本机对照；VPS 上用 clone 路径作 `VAULT_PATH`）。
