import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultLayout } from "../config.js";
import type { AgentContext } from "../types.js";
import {
  buildCodexAgentArgs,
  createCodexAgentRunner,
} from "./codex-runner.js";

describe("Codex agent runner", () => {
  it("处理端显式传入模型和最大思考程度", () => {
    expect(
      buildCodexAgentArgs({
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        extraArgs: ["--json"],
      }),
    ).toEqual([
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-m",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="max"',
      "--json",
    ]);
  });

  it("Windows .cmd runner 将完整 prompt 通过 stdin 传输", async () => {
    if (process.platform !== "win32") return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "koubo-codex-runner-"));
    const vaultPath = path.join(tempDir, "vault");
    const processorPath = path.join(vaultPath, "_processor");
    const captureScript = path.join(tempDir, "capture.mjs");
    const stateFile = path.join(tempDir, "capture.json");
    const commandFile = path.join(tempDir, "capture.cmd");
    await mkdir(processorPath, { recursive: true });
    await writeFile(
      captureScript,
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        "process.stdin.on(\"end\", () => {",
        '  const processorPath = process.env.TEST_PROCESSOR_PATH;',
        '  mkdirSync(processorPath, { recursive: true });',
        '  writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), input }), "utf8");',
        '  writeFileSync(path.join(processorPath, "last-run.json"), JSON.stringify({ ok: true, round_id: "round-codex-test", round_ended_at: "2026-08-03T00:00:00.000Z", processed: [], failed: [], quarantine: [] }), "utf8");',
        "});",
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
      const layout = defaultLayout(vaultPath);
      const context: AgentContext = {
        vaultPath,
        layout,
        maxPerRound: 1,
        pendingInbox: ["_inbox/20260803-test.md"],
        roundId: "round-codex-test",
      };
      await createCodexAgentRunner({
        bin: commandFile,
        env: { TEST_PROCESSOR_PATH: processorPath },
        timeoutMs: 5_000,
      }).run(context);

      const captured = JSON.parse(await readFile(stateFile, "utf8")) as {
        args: string[];
        input: string;
      };
      expect(captured.args).toEqual([
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "workspace-write",
        "-m",
        "gpt-5.6-luna",
        "-c",
        'model_reasoning_effort="max"',
        "-c",
        "sandbox_workspace_write.network_access=true",
      ]);
      expect(captured.input).toContain('"round_id": "round-codex-test"');
      expect(captured.input).toContain("_inbox/20260803-test.md");
      expect(captured.input).toContain('"round_ended_at": "<ISO 时间>"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
