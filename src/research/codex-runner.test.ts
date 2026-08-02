import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createResearchBriefRunner,
  type ResearchEvidenceBundle,
} from "./brief.js";
import {
  buildCodexResearchArgs,
  buildResearchPrompt,
  createCodexResearchRunner,
} from "./codex-runner.js";
import {
  createTempVault,
  fixedClock,
  type TempVault,
  writeDiary,
} from "../testkit/temp-vault.js";
import {
  createResearchTask,
  writeResearchTasks,
} from "./tasks.js";
import type { ResearchRunnerContext } from "../types.js";

describe("Codex research runner", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("把研究配置和任务上下文传给 CLI，并返回可验收的 brief", async () => {
    const { vault, context } = await createResearchContext(vaults);
    let captured:
      | {
          bin: string;
          args: string[];
          cwd: string;
          timeoutMs: number;
        }
      | undefined;

    const result = await createCodexResearchRunner({
      bin: "codex-test.cmd",
      skill: "research-brief",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      timeoutMs: 1234,
      runCommand: async (input) => {
        captured = {
          bin: input.bin,
          args: input.args,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
        };
        const fakeRunner = createResearchBriefRunner({
          async collect({ task }) {
            return validEvidence(task.question);
          },
        });
        const fakeResult = await fakeRunner.run(input.context);
        expect(fakeResult.status).toBe("complete");
      },
    }).run(context);

    expect(result.status).toBe("complete");
    expect(result.brief).toMatch(/^Yan帳\/研究\/[^/]+\.md$/);
    expect(captured).toMatchObject({
      bin: "codex-test.cmd",
      cwd: vault.root,
      timeoutMs: 1234,
    });
    expect(captured?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "workspace-write",
        "-m",
        "gpt-5.6-luna",
        "-c",
        'model_reasoning_effort="max"',
      ]),
    );
    const prompt = captured?.args.at(-1) ?? "";
    expect(prompt).toContain("research-brief");
    expect(prompt).toContain(context.task.task_id);
    expect(prompt).toContain(context.task.question);
    expect(prompt).toContain(context.layout.researchDir);
    expect(prompt).toContain(context.layout.processorDir);
    expect(prompt).toContain("不得执行 git");
    expect(await readFile(path.join(vault.root, result.brief!), "utf8")).toContain(
      "research_status: complete",
    );
  });

  it("CLI 失败时返回 blocked，并保持来源 needs_research", async () => {
    const { vault, context } = await createResearchContext(vaults);
    const result = await createCodexResearchRunner({
      runCommand: async () => {
        throw new Error("Codex login required");
      },
    }).run(context);

    expect(result.status).toBe("blocked");
    expect(result.lastError).toContain("login required");
    expect(await readFile(path.join(vault.root, context.task.source_diary!), "utf8")).toContain(
      "needs_research: true",
    );
  });

  it("研究参数显式映射到 Codex exec", () => {
    const args = buildCodexResearchArgs({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      prompt: "研究任务",
    });

    expect(args).toEqual([
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-m",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="max"',
      "研究任务",
    ]);
  });

  it("研究 prompt 携带来源、状态和边界", async () => {
    const { context } = await createResearchContext(vaults);
    const prompt = buildResearchPrompt(context, "research-brief", "Codex research");

    expect(prompt.split("\n", 1)[0]).toBe(
      "你通过 Codex research 运行。禁止使用全局 skills 和项目级别 skills，只允许使用我让你使用的 skills 或 MCP。",
    );
    expect(prompt).toContain("action: start");
    expect(prompt).toContain("research_status: running");
    expect(prompt).toContain(context.layout.diaryDir);
    expect(prompt).toContain(context.task.source_diary!);
    expect(prompt).toContain("国外和国际来源优先");
    expect(prompt).toContain("不得修改 _inbox");
    expect(prompt).toContain("不得执行 git");
  });
});

async function createResearchContext(vaults: TempVault[]): Promise<{
  vault: TempVault;
  context: ResearchRunnerContext;
}> {
  const vault = await createTempVault();
  vaults.push(vault);
  const clock = fixedClock("2026-08-01T12:00:00+08:00");
  const diary = await writeDiary(
    vault.layout,
    "2026/2026-08/2026-08-01.md",
    "需要研究的来源日记。\n",
  );
  const task = createResearchTask({
    taskId: "task-real-runner",
    sourceDiary: diary,
    question: "如何验证这个研究方案？",
    now: clock.now().toISOString(),
  });
  await writeResearchTasks(vault.layout, [task]);
  return {
    vault,
    context: {
      vaultPath: vault.root,
      layout: vault.layout,
      task: { ...task, status: "running" },
      now: clock.now(),
    },
  };
}

function validEvidence(question: string): ResearchEvidenceBundle {
  const source = (id: "original" | "independent" | "counter") => ({
    id,
    kind: id,
    title: `${id} source`,
    authorOrInstitution: `${id} institution`,
    publishedAt: "2024-01-01",
    accessedAt: "2026-08-01",
    url: `https://example.com/${id}`,
    scope: "测试范围",
    limitations: "测试限制",
    evidence: "测试证据",
    verified: true,
  });
  return {
    title: "真实 runner 测试研究",
    question,
    executiveSummary: "测试结论。",
    facts: [
      {
        claim: "测试事实。",
        evidence: "测试证据。",
        sourceIds: ["original", "independent"],
      },
    ],
    inferences: ["测试推断。"],
    recommendations: ["测试建议。"],
    perspectives: [
      {
        label: "支持观点",
        viewpoint: "测试支持观点。",
        sourceIds: ["original"],
        redTeam: false,
      },
      {
        label: "反方审查",
        viewpoint: "测试反方观点。",
        sourceIds: ["counter"],
        redTeam: true,
      },
    ],
    unknowns: ["测试未知点。"],
    limitations: ["测试限制。"],
    method: ["测试方法。"],
    stopReason: "测试停止依据。",
    sources: [source("original"), source("independent"), source("counter")],
  };
}
