import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDiaryPath, isIdeaPath, isResearchPath } from "../config.js";
import {
  findResearchBriefForTask,
  markResearchBriefIncomplete,
  markResearchPending,
  ResearchWritebackError,
  validateResearchWriteback,
} from "./brief.js";
import {
  countUnfinishedResearchTasks,
  countRunnableResearchTasks,
  dedupeResearchTasks,
  readResearchTasks,
  recoverRunningResearchTasks,
  writeResearchTasks,
} from "./tasks.js";
import { logError, logInfo } from "../runtime/log.js";
import type {
  Clock,
  ResearchRunner,
  ResearchRunnerResult,
  ResearchTask,
  VaultLayout,
} from "../types.js";
import { pathExists } from "../vault/fs.js";

export type ResearchStageResult = {
  processed: number;
  pending: number;
  progressed: boolean;
  error?: string;
};

export async function safeUnfinishedResearchCount(
  layout: VaultLayout,
): Promise<number> {
  try {
    return await countUnfinishedResearchTasks(layout);
  } catch (error) {
    const message = errorMessage(error);
    logError("processor.research_state_read_failed", {
      message,
    });
    throw new Error(`研究任务状态读取失败: ${message}`, { cause: error });
  }
}

export async function safeRunnableResearchCount(
  layout: VaultLayout,
): Promise<number> {
  try {
    return await countRunnableResearchTasks(layout);
  } catch (error) {
    const message = errorMessage(error);
    logError("processor.research_state_read_failed", {
      message,
    });
    throw new Error(`研究任务状态读取失败: ${message}`, { cause: error });
  }
}

export async function runResearchStage(args: {
  layout: VaultLayout;
  maxResearchPerRound: number;
  runner: ResearchRunner | undefined;
  clock: Clock;
  retryFailedResearch?: boolean;
}): Promise<ResearchStageResult> {
  const {
    layout,
    maxResearchPerRound,
    runner,
    clock,
    retryFailedResearch = true,
  } = args;
  let tasks: ResearchTask[];
  try {
    tasks = recoverRunningResearchTasks(await readResearchTasks(layout));
    const normalized = dedupeResearchTasks(tasks);
    const hydrated = hydrateResearchRelations(normalized);
    if (
      hydrated.length > 0 &&
      JSON.stringify(hydrated) !== JSON.stringify(tasks)
    ) {
      await writeResearchTasks(layout, hydrated);
    }
    tasks = hydrated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("processor.research_state_read_failed", { message });
    return {
      processed: 0,
      pending: 0,
      progressed: false,
      error: `研究任务状态不可用: ${message}`,
    };
  }

  const pendingTasks = tasks.filter((task) => task.status === "pending");
  const retryTasks =
    runner && retryFailedResearch
      ? tasks.filter(
          (task) => task.status === "partial" || task.status === "blocked",
        )
      : [];
  const allPendingTasks = [...pendingTasks, ...retryTasks];
  const candidates = allPendingTasks.slice(0, Math.max(0, maxResearchPerRound));
  const unfinished = tasks.filter((task) => task.status !== "complete").length;
  if (!runner) {
    return {
      processed: 0,
      pending: unfinished,
      progressed: false,
      ...(unfinished > 0
        ? { error: "research runner 不可用，仍有未完成研究任务" }
        : {}),
    };
  }
  if (candidates.length === 0) {
    return {
      processed: 0,
      pending: unfinished,
      progressed: false,
    };
  }

  let processed = 0;
  let firstFailure: string | undefined;
  const startedAt = Date.now();
  logInfo("processor.research_started", {
    selected: candidates.length,
    maxResearchPerRound,
  });
  for (const candidate of candidates) {
    const running = {
      ...candidate,
      status: "running" as const,
      updated_at: clock.now().toISOString(),
    };
    tasks = replaceResearchTask(tasks, running);
    await writeResearchTasks(layout, tasks);

    let outcome: ResearchRunnerResult;
    if (!candidate.source_diary && !candidate.source_idea) {
      outcome = {
        status: "blocked",
        lastError: "研究任务缺少来源日记或来源想法",
      };
    } else {
      const sourceError = await validateResearchTaskSource(layout, candidate);
      if (sourceError) {
        outcome = {
          status: "blocked",
          lastError: sourceError,
        };
      } else {
        try {
          outcome = await runner.run({
            vaultPath: layout.vaultPath,
            layout,
            task: running,
            now: clock.now(),
            action: candidate.status === "pending" ? "start" : "refresh",
          });
        } catch (error) {
          if (!(error instanceof ResearchWritebackError)) throw error;
          outcome = { status: "blocked", lastError: error.message };
        }
      }
    }

    let failureMarked = false;
    let failureWritebackError: string | undefined;
    let acceptedFailureBrief: string | undefined;
    if (outcome.status === "complete") {
      let writebackError: string | undefined;
      if (
        outcome.brief === undefined ||
        !isResearchPath(outcome.brief, layout) ||
        !(await pathExists(path.join(layout.vaultPath, outcome.brief)))
      ) {
        writebackError = "研究 runner 未提供合法且存在的 brief 路径";
      } else {
        writebackError = await validateResearchWriteback({
          layout,
          task: running,
          briefPath: outcome.brief,
        });
        if (!writebackError) {
          writebackError = await ensureRelatedBriefBacklinks({
            layout,
            briefPath: outcome.brief,
            relatedBriefs: running.related_briefs ?? [],
          });
        }
      }
      if (writebackError) {
        const failureBrief = await resolveResearchFailureBrief(
          layout,
          running,
          outcome.brief,
        );
        acceptedFailureBrief = failureBrief;
        if (
          failureBrief &&
          shouldDowngradeBrief(running, outcome.brief, failureBrief)
        ) {
          try {
            await markResearchBriefIncomplete({
              layout,
              briefPath: failureBrief,
              status: "partial",
            });
          } catch (error) {
            failureWritebackError = errorMessage(error);
          }
        }
        try {
          await markResearchPending(
            {
              vaultPath: layout.vaultPath,
              layout,
              task: running,
              now: clock.now(),
            },
            "partial",
            failureBrief,
            writebackError,
          );
        } catch (error) {
          failureWritebackError = appendResearchFailure(
            failureWritebackError,
            errorMessage(error),
          );
        }
        failureMarked = true;
        outcome = {
          status: "partial",
          ...(failureBrief ? { brief: failureBrief } : {}),
          lastError: writebackError,
        };
      }
    }
    if (
      !failureMarked &&
      (outcome.status === "partial" || outcome.status === "blocked")
    ) {
      const failureBrief = await resolveResearchFailureBrief(
        layout,
        running,
        outcome.brief,
      );
      acceptedFailureBrief = failureBrief;
      if (
        failureBrief &&
        shouldDowngradeBrief(running, outcome.brief, failureBrief)
      ) {
        try {
          await markResearchBriefIncomplete({
            layout,
            briefPath: failureBrief,
            status: outcome.status,
          });
        } catch (error) {
          failureWritebackError = errorMessage(error);
        }
      }
      try {
        await markResearchPending(
          {
            vaultPath: layout.vaultPath,
            layout,
            task: running,
            now: clock.now(),
          },
          outcome.status,
          failureBrief,
          outcome.lastError,
        );
      } catch (error) {
        failureWritebackError = appendResearchFailure(
          failureWritebackError,
          errorMessage(error),
        );
      }
    }
    const taskOutcome =
      outcome.status === "complete"
        ? outcome
        : {
            status: outcome.status,
            ...(acceptedFailureBrief ? { brief: acceptedFailureBrief } : {}),
            ...(outcome.lastError !== undefined
              ? { lastError: outcome.lastError }
              : {}),
          };
    const completed = applyResearchOutcome(running, taskOutcome, clock.now());
    tasks = replaceResearchTask(tasks, completed);
    await writeResearchTasks(layout, tasks);
    if (failureWritebackError) {
      throw new Error(`研究失败状态写回失败: ${failureWritebackError}`);
    }
    processed += 1;
    if (
      firstFailure === undefined &&
      (completed.status === "blocked" || completed.status === "partial")
    ) {
      firstFailure = `研究任务 ${completed.task_id} 未完成：${completed.last_error ?? completed.status}`;
    }
    logInfo("processor.research_task_finished", {
      taskId: completed.task_id,
      status: completed.status,
      ...(completed.last_error ? { error: completed.last_error } : {}),
    });
  }

  const pending = tasks.filter((task) => task.status !== "complete").length;
  logInfo("processor.research_finished", {
    processed,
    pending,
    durationMs: Date.now() - startedAt,
  });
  return {
    processed,
    pending,
    progressed: processed > 0,
    ...(firstFailure ? { error: firstFailure } : {}),
  };
}

export function researchDetail(result: ResearchStageResult): string {
  return `research_processed=${result.processed} research_pending=${result.pending}`;
}

function replaceResearchTask(
  tasks: ResearchTask[],
  replacement: ResearchTask,
): ResearchTask[] {
  return tasks.map((task) =>
    task.task_id === replacement.task_id ? replacement : task,
  );
}

function hydrateResearchRelations(tasks: ResearchTask[]): ResearchTask[] {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const byBrief = new Map(
    tasks
      .filter((task): task is ResearchTask & { brief: string } => task.brief !== undefined)
      .map((task) => [normalizePath(task.brief), task.task_id]),
  );
  const directTaskLinks = new Map<string, string[]>();
  const reverseTaskLinks = new Map<string, Set<string>>();
  for (const task of tasks) {
    const relatedTaskIds = normalizeStringList([
      ...(task.related_task_ids ?? []),
      ...(task.related_briefs ?? [])
        .map((brief) => byBrief.get(normalizePath(brief)))
        .filter((taskId): taskId is string => taskId !== undefined),
    ]).filter((taskId) => taskId !== task.task_id && byId.has(taskId));
    directTaskLinks.set(task.task_id, relatedTaskIds);
    for (const relatedTaskId of relatedTaskIds) {
      if (relatedTaskId === task.task_id || !byId.has(relatedTaskId)) continue;
      const links = reverseTaskLinks.get(relatedTaskId) ?? new Set<string>();
      links.add(task.task_id);
      reverseTaskLinks.set(relatedTaskId, links);
    }
  }
  return tasks.map((task) => {
    const relatedTaskIds = normalizeStringList([
      ...(directTaskLinks.get(task.task_id) ?? []),
      ...(reverseTaskLinks.get(task.task_id) ?? []),
    ]).filter((taskId) => taskId !== task.task_id);
    const relatedBriefs = [
      ...(task.related_briefs ?? []),
      ...relatedTaskIds
        .map((taskId) => byId.get(taskId)?.brief)
        .filter((brief): brief is string => brief !== undefined),
    ];
    const uniqueBriefs = [...new Set(relatedBriefs)];
    const next = { ...task };
    if (relatedTaskIds.length > 0) next.related_task_ids = relatedTaskIds;
    if (uniqueBriefs.length > 0) next.related_briefs = uniqueBriefs;
    return next;
  });
}

async function ensureRelatedBriefBacklinks(args: {
  layout: VaultLayout;
  briefPath: string;
  relatedBriefs: string[];
}): Promise<string | undefined> {
  const currentBrief = normalizePath(args.briefPath);
  const currentLink = toWikilink(currentBrief);
  for (const relatedBrief of normalizeStringList(args.relatedBriefs)) {
    const normalizedRelated = normalizePath(relatedBrief);
    if (normalizedRelated === currentBrief) {
      return `研究简报不能关联自身: ${currentBrief}`;
    }
    if (!isResearchPath(normalizedRelated, args.layout)) {
      return `关联研究简报路径不合法: ${relatedBrief}`;
    }
    const relatedAbsolutePath = path.join(
      args.layout.vaultPath,
      normalizedRelated,
    );
    if (!(await pathExists(relatedAbsolutePath))) {
      return `关联研究简报不存在: ${normalizedRelated}`;
    }
    const body = await readFile(relatedAbsolutePath, "utf8");
    if (body.includes(currentLink)) continue;
    await writeFile(
      relatedAbsolutePath,
      appendRelatedResearchLink(body, currentLink),
      "utf8",
    );
  }
  return undefined;
}

function appendRelatedResearchLink(body: string, link: string): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const headingPattern = /^##[ \t]+(?:Related research|相关研究)[ \t]*\r?\n/gim;
  let heading: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(body)) !== null) heading = match;

  if (!heading || heading.index === undefined) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}${eol}${eol}## Related research${eol}${eol}- ${link}${eol}`;
  }

  const sectionStart = heading.index + heading[0].length;
  const nextHeadingPattern = /^##[ \t]+/gm;
  nextHeadingPattern.lastIndex = sectionStart;
  const nextHeading = nextHeadingPattern.exec(body);
  const sectionEnd = nextHeading?.index ?? body.length;
  const sectionBody = body.slice(sectionStart, sectionEnd).replace(/\s+$/, "");
  const section = sectionBody.length > 0
    ? `${sectionBody}${eol}- ${link}${eol}`
    : `- ${link}${eol}`;
  return `${body.slice(0, sectionStart)}${section}${body.slice(sectionEnd)}`;
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toWikilink(relativePath: string): string {
  return `[[${relativePath.replace(/\\/g, "/").replace(/\.md$/, "")}]]`;
}

function applyResearchOutcome(
  task: ResearchTask,
  outcome: ResearchRunnerResult,
  now: Date,
): ResearchTask {
  const { last_error: _lastError, ...withoutError } = task;
  const next: ResearchTask = {
    ...withoutError,
    status: outcome.status,
    updated_at: now.toISOString(),
  };
  if (outcome.status !== "complete") {
    next.last_error = outcome.lastError ?? `研究任务状态为 ${outcome.status}`;
  }
  if (outcome.brief !== undefined) next.brief = outcome.brief;
  return next;
}

async function validateResearchTaskSource(
  layout: VaultLayout,
  task: ResearchTask,
): Promise<string | undefined> {
  if (task.source_diary !== undefined) {
    if (!isDiaryPath(task.source_diary, layout)) {
      return `研究任务 source_diary 路径不合法: ${task.source_diary}`;
    }
    if (!(await pathExists(path.join(layout.vaultPath, task.source_diary)))) {
      return `研究任务 source_diary 不存在: ${task.source_diary}`;
    }
  }
  if (task.source_idea !== undefined) {
    if (!isIdeaPath(task.source_idea, layout)) {
      return `研究任务 source_idea 路径不合法: ${task.source_idea}`;
    }
    if (!(await pathExists(path.join(layout.vaultPath, task.source_idea)))) {
      return `研究任务 source_idea 不存在: ${task.source_idea}`;
    }
  }
  return undefined;
}

async function resolveResearchFailureBrief(
  layout: VaultLayout,
  task: ResearchTask,
  briefPath: string | undefined,
): Promise<string | undefined> {
  const candidates = [...new Set([briefPath, task.brief].filter(Boolean))] as string[];
  for (const candidate of candidates) {
    if (!isResearchPath(candidate, layout)) continue;
    if (!(await pathExists(path.join(layout.vaultPath, candidate)))) continue;
    const normalizedCandidate = candidate.replace(/\\/g, "/");
    const matched = await findResearchBriefForTask(layout, {
      ...task,
      brief: normalizedCandidate,
    });
    if (matched === normalizedCandidate) return normalizedCandidate;
  }
  return undefined;
}

function appendResearchFailure(
  previous: string | undefined,
  next: string,
): string {
  return previous ? `${previous}; ${next}` : next;
}

function shouldDowngradeBrief(
  task: ResearchTask,
  outcomeBrief: string | undefined,
  acceptedBrief: string | undefined,
): boolean {
  return (
    acceptedBrief !== undefined &&
    outcomeBrief !== undefined &&
    (!task.brief || normalizePath(outcomeBrief) !== normalizePath(task.brief))
  );
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
