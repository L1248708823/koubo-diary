import path from "node:path";
import { isDiaryPath, isIdeaPath, isResearchPath } from "../config.js";
import {
  countPendingResearchTasks,
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

export async function safePendingResearchCount(
  layout: VaultLayout,
): Promise<number | undefined> {
  try {
    return await countPendingResearchTasks(layout);
  } catch (error) {
    logError("processor.research_state_read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function safeRunnableResearchCount(
  layout: VaultLayout,
): Promise<number | undefined> {
  try {
    return await countRunnableResearchTasks(layout);
  } catch (error) {
    logError("processor.research_state_read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
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
    if (
      normalized.length > 0 &&
      JSON.stringify(normalized) !== JSON.stringify(tasks)
    ) {
      await writeResearchTasks(layout, normalized);
    }
    tasks = normalized;
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
  if (!runner || candidates.length === 0) {
    return {
      processed: 0,
      pending: tasks.filter((task) => task.status === "pending").length,
      progressed: false,
    };
  }

  let processed = 0;
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
          });
        } catch (error) {
          outcome = {
            status: "blocked",
            lastError: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    if (
      outcome.status === "complete" &&
      (outcome.brief === undefined ||
        !isResearchPath(outcome.brief, layout) ||
        !(await pathExists(path.join(layout.vaultPath, outcome.brief))))
    ) {
      outcome = {
        status: "partial",
        lastError: "研究 runner 未提供合法且存在的 brief 路径",
      };
    }
    const completed = applyResearchOutcome(running, outcome, clock.now());
    tasks = replaceResearchTask(tasks, completed);
    await writeResearchTasks(layout, tasks);
    processed += 1;
    logInfo("processor.research_task_finished", {
      taskId: completed.task_id,
      status: completed.status,
    });
  }

  const pending = tasks.filter((task) => task.status === "pending").length;
  logInfo("processor.research_finished", {
    processed,
    pending,
    durationMs: Date.now() - startedAt,
  });
  return { processed, pending, progressed: processed > 0 };
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
  if (outcome.lastError !== undefined) next.last_error = outcome.lastError;
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
