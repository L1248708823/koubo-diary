import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResearchTask, VaultLayout } from "../types.js";

const TASK_FILE = "research-tasks.json";

export function createResearchTask(input: {
  taskId: string;
  sourceDiary?: string;
  sourceIdea?: string;
  relatedTaskIds?: string[];
  relatedBriefs?: string[];
  question: string;
  researchMode?: ResearchTask["research_mode"];
  now: string;
}): ResearchTask {
  const taskId = input.taskId.trim();
  if (taskId.length === 0) {
    throw new Error("研究任务 task_id 不能为空");
  }
  const question = input.question.trim();
  if (question.length === 0) {
    throw new Error("研究任务 question 不能为空");
  }
  const task: ResearchTask = {
    task_id: taskId,
    question,
    status: "pending",
    created_at: input.now,
    updated_at: input.now,
  };
  if (input.researchMode !== undefined) task.research_mode = input.researchMode;
  if (input.sourceDiary !== undefined) task.source_diary = input.sourceDiary;
  if (input.sourceIdea !== undefined) task.source_idea = input.sourceIdea;
  const relatedTaskIds = normalizeStringList(input.relatedTaskIds);
  const relatedBriefs = normalizeStringList(input.relatedBriefs);
  if (relatedTaskIds.length > 0) task.related_task_ids = relatedTaskIds;
  if (relatedBriefs.length > 0) task.related_briefs = relatedBriefs;
  return task;
}

export async function readResearchTasks(
  layout: VaultLayout,
): Promise<ResearchTask[]> {
  const file = taskFilePath(layout);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "tasks" in parsed
      ? (parsed as { tasks?: unknown }).tasks
      : undefined;
  if (!Array.isArray(entries)) {
    throw new Error("研究任务状态格式不合法");
  }
  const fallbackTimestamp = await taskFileTimestamp(file);
  return dedupeResearchTasks(
    entries.map((entry) => parseResearchTask(entry, fallbackTimestamp)),
  );
}

export async function writeResearchTasks(
  layout: VaultLayout,
  tasks: ResearchTask[],
): Promise<void> {
  const dir = path.join(layout.vaultPath, layout.processorDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    taskFilePath(layout),
    JSON.stringify({ tasks: dedupeResearchTasks(tasks) }, null, 2) + "\n",
    "utf8",
  );
}

export function recoverRunningResearchTasks(
  tasks: ResearchTask[],
): ResearchTask[] {
  return tasks.map((task) =>
    task.status === "running" ? { ...task, status: "pending" } : task,
  );
}

export async function countPendingResearchTasks(
  layout: VaultLayout,
): Promise<number> {
  const tasks = recoverRunningResearchTasks(await readResearchTasks(layout));
  return tasks.filter((task) => task.status === "pending").length;
}

export async function countUnfinishedResearchTasks(
  layout: VaultLayout,
): Promise<number> {
  const tasks = recoverRunningResearchTasks(await readResearchTasks(layout));
  return tasks.filter((task) => task.status !== "complete").length;
}

export async function countRunnableResearchTasks(
  layout: VaultLayout,
): Promise<number> {
  const tasks = recoverRunningResearchTasks(await readResearchTasks(layout));
  return tasks.filter(
    (task) =>
      task.status === "pending" ||
      task.status === "partial" ||
      task.status === "blocked",
  ).length;
}

export function dedupeResearchTasks(tasks: ResearchTask[]): ResearchTask[] {
  const byIdentity = new Map<string, ResearchTask>();
  for (const task of tasks) {
    const identity = researchTaskIdentity(task);
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, task);
      continue;
    }

    const newer = task.updated_at >= previous.updated_at ? task : previous;
    const older = newer === task ? previous : task;
    const merged: ResearchTask = {
      ...older,
      ...newer,
      created_at:
        older.created_at <= newer.created_at
          ? older.created_at
          : newer.created_at,
      // 保留更新任务未重复携带的失败与简报信息，避免刷新任务时丢历史。
      ...(newer.last_error === undefined &&
      older.last_error !== undefined &&
      newer.status !== "complete"
        ? { last_error: older.last_error }
        : {}),
      ...(newer.brief === undefined && older.brief !== undefined
        ? { brief: older.brief }
        : {}),
    };
    const relatedTaskIds = normalizeStringList([
      ...(older.related_task_ids ?? []),
      ...(newer.related_task_ids ?? []),
    ]);
    const relatedBriefs = normalizeStringList([
      ...(older.related_briefs ?? []),
      ...(newer.related_briefs ?? []),
    ]);
    if (relatedTaskIds.length > 0) {
      merged.related_task_ids = relatedTaskIds;
    } else {
      delete merged.related_task_ids;
    }
    if (relatedBriefs.length > 0) {
      merged.related_briefs = relatedBriefs;
    } else {
      delete merged.related_briefs;
    }
    byIdentity.set(identity, merged);
  }
  return [...byIdentity.values()].sort((a, b) =>
    a.task_id.localeCompare(b.task_id),
  );
}

export function taskFilePath(layout: VaultLayout): string {
  return path.join(layout.vaultPath, layout.processorDir, TASK_FILE);
}

function researchTaskIdentity(task: ResearchTask): string {
  const source = `${task.source_diary ?? ""}|${task.source_idea ?? ""}`;
  return `${source}|${task.question.trim()}`;
}

function parseResearchTask(raw: unknown, fallbackTimestamp: string): ResearchTask {
  if (!raw || typeof raw !== "object") {
    throw new Error("研究任务条目格式不合法");
  }
  const item = raw as Record<string, unknown>;
  if (
    typeof item.task_id !== "string" ||
    item.task_id.trim().length === 0 ||
    typeof item.question !== "string" ||
    !isResearchTaskStatus(item.status)
  ) {
    throw new Error("研究任务缺少必要字段");
  }
  const question = item.question.trim();
  if (question.length === 0) {
    throw new Error("研究任务 question 不能为空");
  }
  const createdAt = readTimestampField(
    item.created_at,
    fallbackTimestamp,
    "created_at",
  );
  const updatedAt = readTimestampField(
    item.updated_at,
    createdAt,
    "updated_at",
  );
  const task: ResearchTask = {
    task_id: item.task_id.trim(),
    question,
    status: item.status,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  const researchMode = parseResearchMode(item.research_mode);
  if (researchMode !== undefined) task.research_mode = researchMode;
  const sourceDiary = parseOptionalString(item.source_diary, "source_diary");
  const sourceIdea = parseOptionalString(item.source_idea, "source_idea");
  if (sourceDiary !== undefined) task.source_diary = sourceDiary;
  if (sourceIdea !== undefined) task.source_idea = sourceIdea;
  if (item.related_task_ids !== undefined) {
    task.related_task_ids = parseStringList(item.related_task_ids, "related_task_ids");
  }
  if (item.related_briefs !== undefined) {
    task.related_briefs = parseStringList(item.related_briefs, "related_briefs");
  }
  const brief = parseOptionalString(item.brief, "brief");
  const lastError = parseOptionalString(item.last_error, "last_error", true);
  if (brief !== undefined) task.brief = brief;
  if (lastError !== undefined) task.last_error = lastError;
  return task;
}

async function taskFileTimestamp(file: string): Promise<string> {
  return (await stat(file)).mtime.toISOString();
}

function readTimestampField(
  value: unknown,
  fallback: string,
  field: string,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`研究任务 ${field} 格式不合法`);
  }
  return value;
}

function isResearchTaskStatus(value: unknown): value is ResearchTask["status"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "partial" ||
    value === "blocked" ||
    value === "complete"
  );
}

function parseResearchMode(
  value: unknown,
): ResearchTask["research_mode"] | undefined {
  if (value === undefined) return undefined;
  if (value !== "converge" && value !== "explore") {
    throw new Error("研究任务 research_mode 格式不合法");
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function parseOptionalString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`研究任务 ${field} 格式不合法`);
  }
  return value.trim();
}

function parseStringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new Error(`研究任务 ${field} 格式不合法`);
  }
  return normalizeStringList(value);
}
