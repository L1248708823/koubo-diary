import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultLayout } from "../config.js";
import {
  buildProcessorPrompt,
  quoteWindowsShellArg,
  runCliProcess,
} from "./cli-runner.js";

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

  it("Windows .cmd runner 保持多行 prompt 为一个参数", async () => {
    if (process.platform !== "win32") return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-cmd-arg-"));
    const captureScript = path.join(tempDir, "capture.mjs");
    const stateFile = path.join(tempDir, "args.json");
    const commandFile = path.join(tempDir, "capture.cmd");
    await writeFile(
      captureScript,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)), "utf8");',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      commandFile,
      [
        "@echo off",
        `"${process.execPath}" "${captureScript}" "${stateFile}" %*`,
      ].join("\r\n") + "\r\n",
      "utf8",
    );

    try {
      const prompt = "第一行\n第二行 pendingInbox\n第三行";
      await runCliProcess({
        provider: "test-cmd",
        bin: commandFile,
        args: [prompt],
        cwd: tempDir,
        env: undefined,
        timeoutMs: 5_000,
        capacityRetries: 0,
        capacityRetryDelayMs: 0,
      });

      const args = JSON.parse(await readFile(stateFile, "utf8")) as string[];
      expect(args).toEqual([prompt.replace(/\r?\n/g, " ")]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Windows .cmd runner 保持完整回执 prompt 的引号和标记", async () => {
    if (process.platform !== "win32") return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-cmd-schema-"));
    const captureScript = path.join(tempDir, "capture.mjs");
    const stateFile = path.join(tempDir, "args.json");
    const commandFile = path.join(tempDir, "capture.cmd");
    await writeFile(
      captureScript,
      [
        'import { writeFileSync } from "node:fs";',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), input }), "utf8"));',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      commandFile,
      [
        "@echo off",
        `"${process.execPath}" "${captureScript}" "${stateFile}" %*`,
      ].join("\r\n") + "\r\n",
      "utf8",
    );

    try {
      const prompt = [
        '回执 JSON：{"ok":true,"processed":[],"failed":[],"quarantine":[]}',
        "```json",
        '  "round_ended_at": "<ISO 时间>"',
        "```",
      ].join("\n");
      await runCliProcess({
        provider: "test-cmd-schema",
        bin: commandFile,
        args: [],
        cwd: tempDir,
        env: undefined,
        timeoutMs: 5_000,
        stdin: prompt,
        capacityRetries: 0,
        capacityRetryDelayMs: 0,
      });

      const captured = JSON.parse(await readFile(stateFile, "utf8")) as {
        args: string[];
        input: string;
      };
      expect(captured.args).toEqual([]);
      expect(captured.input).toBe(prompt);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
        roundId: "round-cli-test",
      },
      "处理收件箱",
      "Codex",
    );

    expect(prompt.split("\n", 1)[0]).toBe(
      "你通过 Codex 运行。禁止使用全局 skills 和项目级别 skills，只允许使用我让你使用的 skills 或 MCP。",
    );
    expect(prompt).toContain("收件/");
    expect(prompt).toContain("处理状态/last-run.json");
    expect(prompt).toContain("研究任务状态：处理状态/research-tasks.json");
    expect(prompt).toContain("created_at");
    expect(prompt).toContain("updated_at");
    expect(prompt).toContain("待查登记研究任务");
    expect(prompt).toContain("不得执行任何 git");
    expect(prompt).toContain("不要读取、搜索或枚举任何 SKILL.md");
    expect(prompt).toContain("草稿/");
    expect(prompt).toContain("round-cli-test");
    expect(prompt).not.toContain("_inbox");
    expect(prompt).not.toContain("_processor");
  });

  it("提示词直接包含当前回执 schema，并明确拒绝旧版字段", () => {
    const prompt = buildProcessorPrompt(
      {
        vaultPath: "D:/vault",
        layout: defaultLayout("D:/vault"),
        maxPerRound: 1,
        pendingInbox: ["_inbox/20260730-test.md"],
        roundId: "round-receipt-schema-test",
      },
      "处理收件箱",
      "Codex",
    );

    expect(prompt).toContain('"ok": true');
    expect(prompt).toContain('"round_id": "round-receipt-schema-test"');
    expect(prompt).toContain('"round_ended_at"');
    expect(prompt).toContain('"processed"');
    expect(prompt).toContain('"failed"');
    expect(prompt).toContain('"quarantine"');
    expect(prompt).toContain("不要使用旧版 items 或 processed_at 字段");
    expect(prompt).not.toContain("见 skill 中的 schema");
  });

  it("提示词明确要求日记条目使用 captured_at 时间戳", () => {
    const prompt = buildProcessorPrompt(
      {
        vaultPath: "D:/vault",
        layout: defaultLayout("D:/vault"),
        maxPerRound: 2,
        pendingInbox: [
          "_inbox/20260730-first.md",
          "_inbox/20260730-second.md",
        ],
        roundId: "round-diary-time-test",
      },
      "处理收件箱",
      "Codex",
    );

    expect(prompt).toContain("每条 done 收件项必须在对应日期日记中新增一个时间条目");
    expect(prompt).toContain("frontmatter 的 captured_at");
    expect(prompt).toContain("`- HH:mm `");
    expect(prompt).toContain("同一天的多条记录合并到同一篇日记");
    expect(prompt).toContain("时间戳不可省略");
    expect(prompt).toContain("正文中用户自写的时间替代 captured_at");
  });

  it("提示词把内容整理限制在本轮快照文件，禁止全库和环境探索", () => {
    const prompt = buildProcessorPrompt(
      {
        vaultPath: "D:/vault",
        layout: defaultLayout("D:/vault"),
        maxPerRound: 1,
        pendingInbox: ["_inbox/20260730-test.md"],
        roundId: "round-scope-test",
      },
      "处理收件箱",
      "Codex",
    );

    expect(prompt.split("\n", 1)[0]).toContain("你通过 Codex 运行");
    expect(prompt).toContain("收件箱输入只能来自本轮快照列出的 pendingInbox 文件");
    expect(prompt).toContain("不要读取、搜索或枚举任何 SKILL.md");
    expect(prompt).toContain("禁止扫描、列出或搜索整个 vault");
    expect(prompt).toContain("禁止枚举环境变量");
    expect(prompt).toContain("不得使用 Get-ChildItem Env:");
    expect(prompt).toContain("不得使用 rg --files");
    expect(prompt).toContain("不得读取列表之外的收件箱文件");
    expect(prompt).toContain("文件隔离总则：可读文件仅限本轮 pendingInbox");
    expect(prompt).toContain("内容整理阶段不得读取或写入 Yan帳/研究");
  });

  it("检测到模型容量错误时按上限重跑，并在后续成功后结束", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-cli-retry-"));
    const stateFile = path.join(tempDir, "attempts.txt");
    const script = [
      "const fs = require('node:fs');",
      `const file = ${JSON.stringify(stateFile)};`,
      "const attempt = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(file, String(attempt));",
      "if (attempt < 3) { console.error('ERROR: Selected model is at capacity. Please try a different model.'); process.exit(1); }",
    ].join("\n");

    try {
      await runCliProcess({
        provider: "test-cli",
        bin: process.execPath,
        args: ["-e", script],
        cwd: tempDir,
        env: undefined,
        timeoutMs: 5_000,
        capacityRetries: 2,
        capacityRetryDelayMs: 0,
      });

      expect(await readFile(stateFile, "utf8")).toBe("3");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("普通 CLI 失败不触发模型容量重跑", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-cli-no-retry-"));
    const stateFile = path.join(tempDir, "attempts.txt");
    const script = [
      "const fs = require('node:fs');",
      `const file = ${JSON.stringify(stateFile)};`,
      "const attempt = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(file, String(attempt));",
      "console.error('ERROR: login required');",
      "process.exit(1);",
    ].join("\n");

    try {
      await expect(
        runCliProcess({
          provider: "test-cli",
          bin: process.execPath,
          args: ["-e", script],
          cwd: tempDir,
          env: undefined,
          timeoutMs: 5_000,
          capacityRetries: 2,
          capacityRetryDelayMs: 0,
        }),
      ).rejects.toThrow("login required");

      expect(await readFile(stateFile, "utf8")).toBe("1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("CLI 失败详情保留输出尾部，避免截掉真正错误", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-cli-tail-"));
    const script = [
      "console.error('prefix '.repeat(400));",
      "console.error('TAIL_FAILURE');",
      "process.exit(1);",
    ].join("\n");

    try {
      await expect(
        runCliProcess({
          provider: "test-cli",
          bin: process.execPath,
          args: ["-e", script],
          cwd: tempDir,
          env: undefined,
          timeoutMs: 5_000,
          capacityRetries: 0,
          capacityRetryDelayMs: 0,
        }),
      ).rejects.toThrow("TAIL_FAILURE");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("限制 CLI 中的 Git 向上探测，避免把工具仓识别为 vault", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-git-ceiling-"));
    const stateFile = path.join(tempDir, "git-ceiling.txt");
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(stateFile)}, process.env.GIT_CEILING_DIRECTORIES ?? '');`,
    ].join("\n");

    try {
      await runCliProcess({
        provider: "test-cli",
        bin: process.execPath,
        args: ["-e", script],
        cwd: tempDir,
        env: undefined,
        timeoutMs: 5_000,
        capacityRetries: 0,
        capacityRetryDelayMs: 0,
      });

      expect(await readFile(stateFile, "utf8")).toBe(path.dirname(tempDir));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
