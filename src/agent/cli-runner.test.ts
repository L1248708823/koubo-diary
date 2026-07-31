import { describe, expect, it } from "vitest";
import { quoteWindowsShellArg } from "./cli-runner.js";

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
});
