import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  runCliProcess,
  type CliProcessOptions,
} from "../agent/cli-runner.js";
import { isResearchPath } from "../config.js";
import type {
  ResearchRunner,
  ResearchRunnerContext,
} from "../types.js";
import {
  findResearchBriefForTask,
  markResearchPending,
} from "./brief.js";

export type ResearchCliProcessInput = CliProcessOptions & {
  context: ResearchRunnerContext;
};

export type ResearchCliProcess = (
  input: ResearchCliProcessInput,
) => Promise<void>;

export type CodexResearchRunnerOptions = {
  bin?: string;
  skill?: string;
  model?: string;
  reasoningEffort?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runCommand?: ResearchCliProcess;
};

export function createCodexResearchRunner(
  options: CodexResearchRunnerOptions = {},
): ResearchRunner {
  const bin =
    options.bin ??
    process.env.RESEARCH_BIN ??
    process.env.CODEX_BIN ??
    (process.platform === "win32" ? "codex.cmd" : "codex");
  const skill = options.skill ?? process.env.RESEARCH_SKILL ?? "research-brief";
  const model = options.model ?? process.env.RESEARCH_MODEL ?? "gpt-5.6-luna";
  const reasoningEffort =
    options.reasoningEffort ??
    process.env.RESEARCH_REASONING_EFFORT ??
    "max";
  const timeoutMs =
    options.timeoutMs ??
    positiveInt(process.env.RESEARCH_TIMEOUT_MS) ??
    15 * 60_000;
  const extraArgs = options.extraArgs ?? [];
  const runCommand =
    options.runCommand ??
    (async (input: ResearchCliProcessInput) => {
      const { context: _context, ...processOptions } = input;
      await runCliProcess(processOptions);
    });

  return {
    async run(ctx) {
      const prompt = buildResearchPrompt(ctx, skill, "Codex research");
      const args = buildCodexResearchArgs({
        model,
        reasoningEffort,
        extraArgs,
        prompt,
      });
      const previousBrief = await findResearchBriefForTask(ctx.layout, ctx.task);
      const previousBody = previousBrief
        ? await readFile(path.join(ctx.vaultPath, previousBrief), "utf8")
        : undefined;

      try {
        await runCommand({
          provider: "Codex research",
          bin,
          args,
          cwd: ctx.vaultPath,
          env: options.env,
          timeoutMs,
          context: ctx,
        });
      } catch (error) {
        await markResearchPending(
          ctx,
          "blocked",
          safeBriefPath(ctx),
        );
        return {
          status: "blocked" as const,
          lastError: `Codex 研究 runner 失败: ${errorMessage(error)}`,
        };
      }

      const brief = await findResearchBriefForTask(ctx.layout, ctx.task);
      if (!brief) {
        await markResearchPending(ctx, "blocked", safeBriefPath(ctx));
        return {
          status: "blocked" as const,
          lastError: "Codex 研究 runner 完成但没有发现合法研究简报",
        };
      }
      if (previousBrief === brief) {
        const nextBody = await readFile(path.join(ctx.vaultPath, brief), "utf8");
        if (nextBody === previousBody) {
          await markResearchPending(ctx, "partial", brief);
          return {
            status: "partial" as const,
            brief,
            lastError: "Codex 研究 runner 未产生新的简报写回",
          };
        }
      }
      return { status: "complete" as const, brief };
    },
  };
}

export function buildCodexResearchArgs(args: {
  model: string;
  reasoningEffort: string;
  prompt: string;
  extraArgs?: string[];
}): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-m",
    args.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(args.reasoningEffort)}`,
    ...(args.extraArgs ?? []),
    args.prompt,
  ];
}

export function buildResearchPrompt(
  ctx: ResearchRunnerContext,
  skill: string,
  provider = "Codex research",
): string {
  const action =
    ctx.action ?? (ctx.task.status === "complete" ? "refresh" : "start");
  const sourceDiary = ctx.task.source_diary ?? "（无来源日记）";
  const sourceIdea = ctx.task.source_idea ?? "（无来源想法）";
  return [
    `你通过 ${provider} 运行。禁止使用全局 skills 和项目级别 skills，只允许使用我让你使用的 skills 或 MCP。`,
    `请严格执行 research skill「${skill}」，完成一个研究任务。`,
    "工作目录已是 vault 根目录，只处理当前任务指定的来源和研究简报。",
    `task_id: ${ctx.task.task_id}`,
    `action: ${action}`,
    `research_status: ${ctx.task.status}`,
    `current_time: ${ctx.now.toISOString()}`,
    `question: ${ctx.task.question}`,
    `source_diary: ${sourceDiary}`,
    `source_idea: ${sourceIdea}`,
    `RESEARCH_DIR: ${ctx.layout.researchDir}`,
    `PROCESSOR_DIR: ${ctx.layout.processorDir}`,
    `DIARY_DIR: ${ctx.layout.diaryDir}`,
    `IDEAS_DIR: ${ctx.layout.ideasDir}`,
    "",
    "研究要求：",
    "1. 来源策略：国外和国际来源优先，覆盖原始资料、独立确认和最强反方观点。",
    "2. 记录事实、推断、建议、未知点、证据边界、适用范围和停止依据。",
    "3. 不编造 URL、作者、标题、日期、数据或无法核验的来源；无法核验的内容明确写未知。",
    "4. 健康、法律、财务或安全主题不能写成个体化诊断或确定性指令。",
    "",
    "写回边界：",
    `5. 研究简报只能直接写入 ${ctx.layout.researchDir}/ 下一层 Markdown。`,
    `6. 只允许修改指定来源笔记、研究简报和 ${ctx.layout.processorDir}/research-tasks.json。`,
    `7. 不得修改 ${ctx.layout.inboxDir}，不得访问或写入隔离区、工具仓和密钥。`,
    "8. 不得执行 git、commit、push、pull 或修改 Git 配置。",
    "9. 只有研究问题、证据、来源、反方、未知点、日期和双向链接都写回并验收后才使用 complete。",
    `10. 完成后让简报位于 ${ctx.layout.researchDir}/ 下一层，并保留与来源笔记的 wikilink 双向回链。`,
  ].join("\n");
}

function safeBriefPath(ctx: ResearchRunnerContext): string | undefined {
  return ctx.task.brief && isResearchPath(ctx.task.brief, ctx.layout)
    ? ctx.task.brief
    : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
