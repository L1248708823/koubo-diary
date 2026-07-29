import { describe, it, expect } from "vitest";
import { isWhitelistedPath, defaultLayout } from "./config.js";
import { makeInboxId } from "./vault/fs.js";

describe("config whitelist", () => {
  const layout = defaultLayout("/vault");

  it("允许收件箱、日记、想法、processor、staging", () => {
    expect(isWhitelistedPath("_inbox/a.md", layout)).toBe(true);
    expect(isWhitelistedPath("日记/2026-07-29.md", layout)).toBe(true);
    expect(isWhitelistedPath("想法/灵感.md", layout)).toBe(true);
    expect(isWhitelistedPath("_processor/last-run.json", layout)).toBe(true);
    expect(isWhitelistedPath("_staging/draft.md", layout)).toBe(true);
  });

  it("拒绝密钥与家目录路径", () => {
    expect(isWhitelistedPath("secrets/token.txt", layout)).toBe(false);
    expect(isWhitelistedPath(".env", layout)).toBe(false);
    expect(isWhitelistedPath("README.md", layout)).toBe(false);
  });
});

describe("inbox id", () => {
  it("生成 YYYYMMDD-HHMMSS- 前缀文件名", () => {
    const { id, filename } = makeInboxId(new Date(2026, 6, 29, 15, 30, 12), "abc123");
    expect(filename).toBe("20260729-153012-abc123.md");
    expect(id).toBe("20260729-153012-abc123");
  });
});
