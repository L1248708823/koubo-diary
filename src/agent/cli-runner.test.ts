import { describe, expect, it } from "vitest";
import { defaultLayout } from "../config.js";
import { buildProcessorPrompt, quoteWindowsShellArg } from "./cli-runner.js";

describe("CLI agent Windows 参数", () => {
  it("完整 prompt 含空格时保持为一个参数", () => {
    if (process.platform !== "win32") return;

    expect(quoteWindowsShellArg("prompt with spaces"))
      .toBe('"prompt with spaces"');
  });

  it("没有空格的参数不增加多余引号", () => {
    if (process.platform !== "win32") return;

    expect(quoteWindowsShellArg("--ephemeral")).toBe("--ephemeral");
  });

  it("提示词使用配置的收件箱和处理目录", () => {
    const layout = {
      ...defaultLayout("D:/vault"),
      inboxDir: "收件",
      processorDir: "处理状态",
      stagingDir: "草稿",
    };
    const prompt = buildProcessorPrompt(
      {
        vaultPath: "D:/vault",
        layout,
        maxPerRound: 1,
        pendingInbox: ["收件/20260730-test.md"],
      },
      "处理收件箱",
    );

    expect(prompt).toContain("收件/");
    expect(prompt).toContain("处理状态/last-run.json");
    expect(prompt).toContain("草稿/");
    expect(prompt).not.toContain("_inbox");
    expect(prompt).not.toContain("_processor");
  });
});
