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
  const explore = skill === "research-explore";
  const modeIntro = explore ? "这是一次发散研究任务。" : "这是一次收敛研究任务。";
  const modeBody = explore
    ? "研究方式：允许质疑和重构原问题，主动寻找被忽略的角度、盲区和假设；产出新问题与产出答案同等有效，不必为凑答案提前收敛。重构的问题写进简报正文。"
    : "研究方式：以验证和回答主问题为主，事实与分析分开，必要时给出诚实判断。";
  const expression = explore
    ? "表达：表达观点用“我”，自然、直接、容易读懂，可以有真实判断和态度。你就像掌握相关领域的朋友一样，大胆发表你的看法。"
    : "表达：表达观点用“我”，自然、直接、容易读懂，可以有真实判断和态度。";
  return [
    `你通过 ${provider} 运行。${modeIntro}`,
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
    "",
    modeBody,
    "",
    "事实边界：外部事实、数据、论文或原始资料支撑的结论需要可核验来源，无法核验时明确写未知，不补写 URL、作者、标题、日期或数据。搜索时不使用中文网站作为信源。",
    "",
    expression,
    "",
    "写回契约：简报位于 RESEARCH_DIR 下一层，一条任务一个 Markdown 文件。文件开头是 frontmatter YAML 块：",
    "---",
    "type: research-brief",
    "task_id: <任务里的 task_id>",
    "research_status: complete",
    "created: YYYY-MM-DD",
    "updated: YYYY-MM-DD",
    'question: "<任务原始问题>"',
    'source_diary: "[[来源日记路径无 .md]]"',
    'source_idea: "[[来源想法路径无 .md]]"',
    "---",
    "无对应来源时省略对应字段。research_status 完成时写 complete，未完成写 partial 或 blocked。简报正文包含来源 wikilink；完成时把来源笔记的 needs_research 改为 false、research_status 改为 complete、清除 research_error，未完成保留 needs_research: true 并记录 research_error。",
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
