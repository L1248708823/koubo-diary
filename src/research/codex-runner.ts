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
  ResearchTask,
} from "../types.js";
import {
  findResearchBriefForTask,
  markResearchBriefIncomplete,
  markResearchPending,
  validateResearchWriteback,
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
  const configuredSkill = options.skill ?? process.env.RESEARCH_SKILL;
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
      const skill = resolveResearchSkill(configuredSkill, ctx.task.research_mode);
      const prompt = buildResearchPrompt(ctx, skill, "Codex research");
      const args = buildCodexResearchArgs({
        model,
        reasoningEffort,
        networkAccess: true,
        extraArgs,
        prompt,
        promptInStdin: true,
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
          stdin: prompt,
          context: ctx,
        });
      } catch (error) {
        const reason = `Codex 研究 runner 失败: ${errorMessage(error)}`;
        await markResearchPending(
          ctx,
          "blocked",
          safeBriefPath(ctx),
          reason,
        );
        return {
          status: "blocked" as const,
          lastError: reason,
        };
      }

      const brief = await findResearchBriefForTask(ctx.layout, ctx.task);
      if (!brief) {
        const reason = "Codex 研究 runner 完成但没有发现合法研究简报";
        await markResearchPending(ctx, "blocked", safeBriefPath(ctx), reason);
        return {
          status: "blocked" as const,
          lastError: reason,
        };
      }
      const writebackError = await validateResearchWriteback({
        layout: ctx.layout,
        task: ctx.task,
        briefPath: brief,
      });
      if (writebackError) {
        await markResearchBriefIncomplete({
          layout: ctx.layout,
          briefPath: brief,
          status: "partial",
        });
        await markResearchPending(ctx, "partial", brief, writebackError);
        return {
          status: "partial" as const,
          brief,
          lastError: writebackError,
        };
      }
      if (previousBrief === brief) {
        const nextBody = await readFile(path.join(ctx.vaultPath, brief), "utf8");
        if (nextBody === previousBody) {
          const reason = "Codex 研究 runner 未产生新的简报写回";
          await markResearchPending(ctx, "partial", brief, reason);
          return {
            status: "partial" as const,
            brief,
            lastError: reason,
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
  networkAccess?: boolean;
  prompt: string;
  promptInStdin?: boolean;
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
    ...(args.networkAccess
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    ...(args.extraArgs ?? []),
    ...(args.promptInStdin ? [] : [args.prompt]),
  ];
}

function resolveResearchSkill(
  configured: string | undefined,
  mode: ResearchTask["research_mode"],
): string {
  if (configured) return configured;
  return mode === "explore" ? "research-explore" : "research-brief";
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
    `你通过 ${provider} 运行。请使用已配置的 research skill「${skill}」，完成一个研究任务。`,
    "工作目录已是 vault 根目录，只处理当前任务指定的来源和研究简报。",
    `task_id: ${ctx.task.task_id}`,
    `action: ${action}`,
    `research_status: ${ctx.task.status}`,
    `current_time: ${ctx.now.toISOString()}`,
    `question: ${ctx.task.question}`,
    `source_diary: ${sourceDiary}`,
    `source_idea: ${sourceIdea}`,
    `related_task_ids: ${(ctx.task.related_task_ids ?? []).join(", ") || "（无）"}`,
    `related_briefs: ${(ctx.task.related_briefs ?? []).join(", ") || "（无）"}`,
    `RESEARCH_DIR: ${ctx.layout.researchDir}`,
    `PROCESSOR_DIR: ${ctx.layout.processorDir}`,
    `DIARY_DIR: ${ctx.layout.diaryDir}`,
    `IDEAS_DIR: ${ctx.layout.ideasDir}`,
    `brief_path: ${ctx.task.brief ?? "（无既有简报，只能在 RESEARCH_DIR 下一层新建当前任务简报）"}`,
    "可以读取和修改完成当前研究任务所需的 vault 文件；不要修改或删除 inbox，不要执行 git、commit、push 或 pull。",
    "研究方式、表达反模式和写回契约由 skill 定义，按 skill 执行。",
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
