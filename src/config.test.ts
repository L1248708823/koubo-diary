import { describe, it, expect } from "vitest";
import {
  defaultLayout,
  isDatedIdeaPath,
  isDiaryPath,
  isIdeaPath,
  isResearchPath,
  isWhitelistedPath,
} from "./config.js";
import { makeInboxId } from "./vault/fs.js";

describe("config whitelist", () => {
  const layout = defaultLayout("/vault");

  it("允许收件箱、日记树、想法、processor、staging", () => {
    expect(isWhitelistedPath("_inbox/a.md", layout)).toBe(true);
    expect(
      isWhitelistedPath("生活/日子一天天过去/2026/2026-07/2026-07-29.md", layout),
    ).toBe(true);
    expect(
      isDiaryPath("生活/日子一天天过去/2026/2026-07/2026-07-29.md", layout),
    ).toBe(true);
    expect(isWhitelistedPath("Yan帳/想法/灵感.md", layout)).toBe(true);
    expect(isIdeaPath("Yan帳/想法/灵感.md", layout)).toBe(true);
    expect(
      isDatedIdeaPath("Yan帳/想法/2026-07-29-灵感.md", layout, "2026-07-29"),
    ).toBe(true);
    expect(
      isDatedIdeaPath("Yan帳/想法/2026-07-07-灵感.md", layout, "2026-07-29"),
    ).toBe(false);
    expect(isWhitelistedPath("Yan帳/研究/简报.md", layout)).toBe(true);
    expect(isResearchPath("Yan帳/研究/简报.md", layout)).toBe(true);
    expect(isWhitelistedPath("_processor/last-run.json", layout)).toBe(true);
    expect(isWhitelistedPath("_staging/draft.md", layout)).toBe(true);
  });

  it("拒绝密钥、旁支笔记与家目录路径", () => {
    expect(isWhitelistedPath("secrets/token.txt", layout)).toBe(false);
    expect(isWhitelistedPath(".env", layout)).toBe(false);
    expect(isWhitelistedPath("README.md", layout)).toBe(false);
    expect(isWhitelistedPath("吾志/2021/2021-11.md", layout)).toBe(false);
    expect(isWhitelistedPath("学习/ai/common.md", layout)).toBe(false);
    expect(isWhitelistedPath("Yan帳/想法", layout)).toBe(false);
    expect(isDiaryPath("README.md", layout)).toBe(false);
    expect(
      isDiaryPath("生活/日子一天天过去/随便.md", layout),
    ).toBe(false);
    expect(
      isWhitelistedPath("生活/日子一天天过去/2026-08-05.md", layout),
    ).toBe(false);
    expect(isIdeaPath("Yan帳/想法/主题/细节.md", layout)).toBe(false);
    expect(isWhitelistedPath("Yan帳/想法/主题/细节.md", layout)).toBe(false);
    expect(
      isWhitelistedPath(
        "生活/日子一天天过去/2026/2026-07/Yan帳/想法/灵感.md",
        layout,
      ),
    ).toBe(false);
    expect(
      isWhitelistedPath(
        "生活/日子一天天过去/2026/2026-07/Yan帳/研究/简报.md",
        layout,
      ),
    ).toBe(false);
    expect(
      isWhitelistedPath(
        "生活/日子一天天过去/2026/2026-07/Yan帳/其他/内容.md",
        layout,
      ),
    ).toBe(false);
  });
});

describe("inbox id", () => {
  it("生成 YYYYMMDD-HHMMSS- 前缀文件名", () => {
    const { id, filename } = makeInboxId(new Date(2026, 6, 29, 15, 30, 12), "abc123");
    expect(filename).toBe("20260729-153012-abc123.md");
    expect(id).toBe("20260729-153012-abc123");
  });
});
