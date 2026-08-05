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
    ...(args.extraArgs ?? []),
    ...(args.promptInStdin ? [] : [args.prompt]),
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
    `related_task_ids: ${(ctx.task.related_task_ids ?? []).join(", ") || "（无）"}`,
    `related_briefs: ${(ctx.task.related_briefs ?? []).join(", ") || "（无）"}`,
    `RESEARCH_DIR: ${ctx.layout.researchDir}`,
    `PROCESSOR_DIR: ${ctx.layout.processorDir}`,
    `DIARY_DIR: ${ctx.layout.diaryDir}`,
    `IDEAS_DIR: ${ctx.layout.ideasDir}`,
    `brief_path: ${ctx.task.brief ?? "（无既有简报，只能在 RESEARCH_DIR 下一层新建当前任务简报）"}`,
    "本地文件隔离：只能读取当前任务指定的 source_diary、source_idea、brief_path（存在时）、related_briefs（存在时）和 PROCESSOR_DIR/research-tasks.json；只能写入这些指定来源、当前任务研究简报和 research-tasks.json。related_briefs 只用于确认关联，research agent 不得改写其正文，关联回链由处理编排器维护。除此之外不得读取、列出、搜索、测试、创建、修改或删除任何本地文件。",
    "不得读取收件箱、隔离区、工具仓、父目录、.git、.env、密钥、临时目录或其它 vault 文件；不得通过目录枚举寻找来源或简报。",
    "Windows PowerShell 5.1 读取 UTF-8 文件时，先在同一命令设置 `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`；所有 Get-Content 必须带 -Encoding UTF8 -Raw，避免中文正文被系统代码页替换。",
    "",
    "研究要求：",
    "1. 来源策略：国外和国际来源优先；搜索时不使用中文网站作为信源，不编造无法核验的来源。",
    "2. 记录事实、推断、建议、未知点、证据边界、适用范围和停止依据。",
    "3. 不编造 URL、作者、标题、日期、数据或无法核验的来源；无法核验的内容明确写未知。",
    "4. 健康、法律、财务或安全主题不能写成个体化诊断或确定性指令。",
    "5. 研究结构根据问题决定，不强制固定章节、来源数量或搜索轮数；事实、推断、建议和未知点需要清楚区分。",
    "6. 需要方案比较时优先提供至少三种真实可行方案，并说明适用条件、优点、缺点、实施代价、复杂度、风险、证据情况和推荐理由；不足三种时说明原因。",
    "7. 只有在争议、比较、较高风险或用户明确要求时加入反方观点，并说明它会改变结论的哪一部分。",
    "8. 同一研究问题出现新资料时更新原 task 和 brief；问题目标或范围变化时创建新 task 和 brief，保留 related_task_ids、related_briefs 和双向链接。",
    "",
    "写回边界：",
    `1. 研究简报只能直接写入 ${ctx.layout.researchDir}/ 下一层 Markdown。`,
    `2. 只允许修改指定来源笔记、研究简报和 ${ctx.layout.processorDir}/research-tasks.json。`,
    `3. 不得修改 ${ctx.layout.inboxDir}，不得访问或写入隔离区、工具仓和密钥。`,
    "4. 不得执行 git、commit、push、pull 或修改 Git 配置。",
    "5. 只有研究问题、事实证据、分析、未知点、来源、日期和双向链接都写回并验收后才使用 complete；反方只在问题需要时写入。",
    `6. 完成后让简报位于 ${ctx.layout.researchDir}/ 下一层，并保留与来源笔记及相关研究的 wikilink 双向回链。`,
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
