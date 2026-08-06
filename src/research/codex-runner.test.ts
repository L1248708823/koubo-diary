import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
          stdin?: string;
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
          stdin: input.stdin,
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
        "-c",
        "sandbox_workspace_write.network_access=true",
      ]),
    );
    const prompt = captured?.stdin ?? "";
    expect(prompt).toContain("research-brief");
    expect(prompt).toContain(context.task.task_id);
    expect(prompt).toContain(context.task.question);
    expect(prompt).toContain(context.layout.researchDir);
    expect(prompt).toContain(context.layout.processorDir);
    expect(prompt).toContain("不要执行 git");
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

  it("CLI 写出受限简报时不报告 complete", async () => {
    const { vault, context } = await createResearchContext(vaults);
    const brief = `${context.layout.researchDir}/受限简报.md`;

    const result = await createCodexResearchRunner({
      runCommand: async ({ context: runContext }) => {
        await mkdir(
          path.join(runContext.vaultPath, runContext.layout.researchDir),
          { recursive: true },
        );
        await writeFile(
          path.join(runContext.vaultPath, brief),
          [
            "---",
            "type: research-brief",
            `task_id: ${runContext.task.task_id}`,
            "research_status: completed_with_limits",
            `question: \"${runContext.task.question}\"`,
            `source_diary: \"[[${runContext.task.source_diary!.replace(/\.md$/, "")}]]\"`,
            "---",
            "",
            "# 受限简报",
            "",
          ].join("\n"),
          "utf8",
        );
      },
    }).run(context);

    expect(result.status).toBe("partial");
    expect(result.brief).toBe(brief);
    expect(result.lastError).toContain("状态未完成");
    expect(
      await readFile(path.join(vault.root, context.task.source_diary!), "utf8"),
    ).toContain("needs_research: true");
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

  it("研究 prompt 携带来源、状态和边界，行为规则交给 skill", async () => {
    const { context } = await createResearchContext(vaults);
    const prompt = buildResearchPrompt(context, "research-brief", "Codex research");

    expect(prompt.split("\n", 1)[0]).toBe(
      "你通过 Codex research 运行。请使用已配置的 research skill「research-brief」，完成一个研究任务。",
    );
    expect(prompt).toContain("action: start");
    expect(prompt).toContain("research_status: running");
    expect(prompt).toContain(context.layout.diaryDir);
    expect(prompt).toContain(context.task.source_diary!);
    expect(prompt).toContain("不要修改或删除 inbox");
    expect(prompt).toContain("不要执行 git");
    expect(prompt).toContain("可以读取和修改完成当前研究任务所需的 vault 文件");
    expect(prompt).toContain("研究方式、表达反模式和写回契约由 skill 定义，按 skill 执行");
    expect(prompt).not.toContain("研究要求：");
    expect(prompt).not.toContain("来源策略");
    expect(prompt).not.toContain("反方观点");
  });

  it("research_mode 为 explore 时使用发散 skill，否则使用收敛 skill", async () => {
    const { context } = await createResearchContext(vaults);
    const exploreContext: ResearchRunnerContext = {
      ...context,
      task: { ...context.task, research_mode: "explore" },
    };
    const explorePrompt = buildResearchPrompt(
      exploreContext,
      "research-explore",
      "Codex research",
    );
    expect(explorePrompt).toContain("research skill「research-explore」");

    let exploreStdin: string | undefined;
    await createCodexResearchRunner({
      bin: "codex-test.cmd",
      runCommand: async (input) => {
        exploreStdin = input.stdin;
      },
    }).run(exploreContext);
    expect(exploreStdin).toContain("research skill「research-explore」");

    const convergeContext: ResearchRunnerContext = {
      ...context,
      task: { ...context.task, research_mode: undefined },
    };
    let convergeStdin: string | undefined;
    await createCodexResearchRunner({
      bin: "codex-test.cmd",
      runCommand: async (input) => {
        convergeStdin = input.stdin;
      },
    }).run(convergeContext);
    expect(convergeStdin).toContain("research skill「research-brief」");
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
