import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import type {
  AgentRunner,
  Clock,
  Lock,
  LockHandle,
  ProcessorOptions,
  ResearchRunner,
  RoundResult,
  VaultPublisher,
  VaultWorkspace,
} from "../types.js";
import {
  bumpInboxAttempts,
  deleteInboxFile,
  listAssociationCandidates,
  listPendingInbox,
  moveToQuarantine,
  pathExists,
  writeState,
} from "../vault/fs.js";
import { acceptRound } from "./accept.js";
import { isWhitelistedPath } from "../config.js";
import { logError, logInfo } from "../runtime/log.js";
import {
  researchDetail,
  runResearchStage,
  safeRunnableResearchCount,
  safeUnfinishedResearchCount,
} from "../research/stage.js";

export type ProcessorDeps = {
  options: ProcessorOptions;
  workspace: VaultWorkspace;
  publisher?: VaultPublisher;
  lock: Lock;
  agent: AgentRunner;
  researchRunner?: ResearchRunner;
  /** 仅新唤醒或直接调用时重试 partial/blocked 研究任务。 */
  retryFailedResearch?: boolean;
  clock: Clock;
};

export async function runProcessorRound(deps: ProcessorDeps): Promise<RoundResult> {
  const { options, workspace, publisher, lock, agent, clock } = deps;
  const retryFailedResearch = deps.retryFailedResearch ?? true;
  const layout = options.layout;
  logInfo("processor.round_started", {
    vaultPath: layout.vaultPath,
    publisher: Boolean(publisher),
    maxPerRound: options.maxPerRound,
  });

  let handle: LockHandle | null;
  try {
    handle = await lock.tryAcquire();
  } catch (error) {
    const reason = errorMessage(error);
    logError("processor.lock_failed", { reason });
    const stateFailure = await writeFailureState(layout, clock, reason);
    return {
      status: "failed",
      reason: stateFailure ? `${reason}; ${stateFailure}` : reason,
      deletedInbox: [],
      quarantined: [],
      agentInvoked: false,
      progressed: false,
      researchProcessed: 0,
      researchPending: 0,
    };
  }
  if (!handle) {
    logInfo("processor.round_locked", { vaultPath: layout.vaultPath });
    return {
      status: "locked",
      reason: "单实例锁已被占用",
      deletedInbox: [],
      quarantined: [],
      agentInvoked: false,
      progressed: false,
      researchProcessed: 0,
      researchPending: 0,
    };
  }

  let agentInvoked = false;
  let deletedInbox: string[] = [];
  let quarantined: string[] = [];
  let progressed = false;
  let researchProcessed = 0;
  let researchPending = 0;

  try {
    const prepared = await workspace.prepare();
    if (!prepared.ok) {
      logError("processor.workspace_failed", {
        reason: prepared.reason,
        conflict: prepared.conflict ?? false,
      });
      await writeStateSafe(
        layout,
        stateBody(
          clock,
          prepared.conflict ? "conflict" : "failed",
          prepared.reason ?? "准备 vault 工作区失败",
          {
            phase: "prepare",
            lastError: prepared.reason ?? "准备 vault 工作区失败",
          },
        ),
      );
      return {
        status: prepared.conflict ? "conflict" : "failed",
        reason: prepared.reason ?? "准备 vault 工作区失败",
        deletedInbox: [],
        quarantined: [],
        agentInvoked: false,
        progressed: false,
        researchProcessed: 0,
        researchPending: 0,
      };
    }

    const allPending = await listPendingInbox(layout);
    const researchPendingBefore = await safeUnfinishedResearchCount(layout);
    const researchRunnableBefore = await safeRunnableResearchCount(layout);
    researchPending = researchPendingBefore;
    logInfo("processor.inbox_scanned", {
      pending: allPending.length,
      selected: Math.min(allPending.length, options.maxPerRound),
    });
    if (allPending.length === 0) {
      if (researchRunnableBefore > 0) {
        const researchInboxSnapshot = await snapshotInbox(layout);
        const research = await runResearchStage({
          layout,
          maxResearchPerRound: options.maxResearchPerRound,
          runner: deps.researchRunner,
          clock,
          retryFailedResearch,
        });
        researchProcessed = research.processed;
        researchPending = research.pending;
        progressed = research.progressed;
        const inboxSafetyError = await verifyResearchInboxUnchanged(
          layout,
          researchInboxSnapshot,
        );
        const status = research.error ? "failed" : "success";
        const detail = research.error
          ? research.error
          : researchDetail(research);
        if (inboxSafetyError) {
          await writeStateSafe(
            layout,
            stateBody(clock, "failed", inboxSafetyError, {
              phase: "research",
              inboxPending: 0,
              researchPending: research.pending,
              lastError: inboxSafetyError,
            }),
          );
          return {
            status: "failed",
            reason: inboxSafetyError,
            deletedInbox: [],
            quarantined: [],
            agentInvoked: false,
            progressed: research.progressed,
            researchProcessed: research.processed,
            researchPending: research.pending,
          };
        }
        await writeStateSafe(
          layout,
          stateBody(clock, status, detail, {
            phase: "research",
            inboxPending: 0,
            researchPending: research.pending,
            ...(research.error ? { lastError: research.error } : {}),
          }),
        );
        const finalChanges = await workspace.listChanges();
        const unauthorized = findUnauthorizedChange(finalChanges, layout);
        if (unauthorized) {
          const recoveryErrors = await restoreUnauthorizedChanges(
            workspace,
            finalChanges,
            layout,
          );
          const reason = appendRecoveryErrors(unauthorized, recoveryErrors);
          await writeStateSafe(
            layout,
            stateBody(clock, "failed", reason, {
              phase: "publish",
              inboxPending: 0,
              researchPending: research.pending,
              lastError: reason,
            }),
          );
          return {
            status: "failed",
            reason,
            deletedInbox: [],
            quarantined: [],
            agentInvoked: false,
            progressed: research.progressed,
            researchProcessed: research.processed,
            researchPending: research.pending,
          };
        }
        const published = await publishChanges(
          publisher,
          finalChanges,
          buildCommitMessage([], [], clock),
          layout,
          clock,
        );
        if (published) {
          return {
            status: published.status,
            reason: published.reason,
            deletedInbox: [],
            quarantined: [],
            agentInvoked: false,
            progressed: research.progressed,
            researchProcessed: research.processed,
            researchPending: research.pending,
          };
        }
        if (research.error) {
          return {
            status: "failed",
            reason: research.error,
            deletedInbox: [],
            quarantined: [],
            agentInvoked: false,
            progressed: research.progressed,
            researchProcessed: research.processed,
            researchPending: research.pending,
          };
        }
        const result: RoundResult = {
          status: "success",
          deletedInbox: [],
          quarantined: [],
          agentInvoked: false,
          progressed: research.progressed,
          researchProcessed: research.processed,
          researchPending: research.pending,
        } as const;
        logInfo("processor.round_finished", result);
        return result;
      }

      await writeStateSafe(
        layout,
        stateBody(clock, "empty", "收件箱无待处理", {
          phase: "idle",
          inboxPending: 0,
          researchPending: researchRunnableBefore,
        }),
      );
      return {
        status: "empty",
        reason: "收件箱无待处理",
        deletedInbox: [],
        quarantined: [],
        agentInvoked: false,
        progressed: false,
        researchProcessed: 0,
        researchPending: researchPendingBefore,
      };
    }

    const pendingInbox = allPending.slice(0, options.maxPerRound);
    const snapshotInboxPaths = [...pendingInbox];
    const associationCandidates = await listAssociationCandidates(layout);
    const roundId = createRoundId(clock);

    const agentStartedAt = Date.now();
    agentInvoked = true;
    logInfo("processor.agent_started", {
      count: pendingInbox.length,
      roundId,
    });
    try {
      await agent.run({
        vaultPath: layout.vaultPath,
        layout,
        maxPerRound: options.maxPerRound,
        pendingInbox,
        roundId,
        associationCandidates,
      });
    } catch (error) {
      logError("processor.agent_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logInfo("processor.agent_finished", {
      count: pendingInbox.length,
      durationMs: Date.now() - agentStartedAt,
    });

    const changes = await workspace.listChanges();
    const acceptance = await acceptRound({
      layout,
      snapshotInbox: snapshotInboxPaths,
      changes,
      roundId,
      existingIdeaPaths: associationCandidates.ideas,
    });
    logInfo("processor.acceptance", {
      ok: acceptance.ok,
      ...(acceptance.ok
        ? {
            done: acceptance.done.length,
            failed: acceptance.failedInboxes.length,
            quarantine: acceptance.quarantineInboxes.length,
          }
        : { reason: acceptance.reason }),
    });

    if (!acceptance.ok) {
      // Restore or remove every path involved in an unsafe agent change.
      const recoveryPaths = unique(acceptance.recoveryPaths);
      const recoveryErrors = await restorePaths(workspace, recoveryPaths);
      const failureReason = appendRecoveryErrors(
        acceptance.reason,
        recoveryErrors,
      );
      // 验收失败：不删 inbox；对快照内仍在的条目 attempts+1，触顶则隔离
      for (const inbox of snapshotInboxPaths) {
        if (!(await pathExists(path.join(layout.vaultPath, inbox)))) continue;
        const attempts = await bumpInboxAttempts(layout, inbox);
        if (attempts >= options.maxAttempts) {
          const dest = await moveToQuarantine(layout, inbox);
          quarantined.push(dest);
          progressed = true;
        }
      }
      await writeStateSafe(
        layout,
        stateBody(clock, "failed", failureReason, {
          phase: "content",
          inboxPending: (await listPendingInbox(layout)).length,
          researchPending: researchPendingBefore,
          lastError: failureReason,
        }),
      );
      // 失败也尽量把 attempts / 隔离 / STATE 提交进去，避免下轮丢计数
      const failurePublishError = await commitWorkingTreeBestEffort(
        workspace,
        publisher,
        layout,
        ("processor: failed " + failureReason).slice(0, 200),
      );
      const finalFailureReason = failurePublishError
        ? failureReason + "; " + failurePublishError
        : failureReason;
      return {
        status: "failed",
        reason: finalFailureReason,
        deletedInbox: [],
        quarantined,
        agentInvoked: true,
        progressed: false,
        researchProcessed: 0,
        researchPending: researchPendingBefore,
      };
    }

    // Handle explicit quarantine from receipt
    for (const inbox of acceptance.quarantineInboxes) {
      if (await pathExists(path.join(layout.vaultPath, inbox))) {
        const dest = await moveToQuarantine(layout, inbox);
        quarantined.push(dest);
        progressed = true;
      }
    }

    // Handle failures: bump attempts, maybe quarantine
    for (const inbox of acceptance.failedInboxes) {
      if (!(await pathExists(path.join(layout.vaultPath, inbox)))) continue;
      const attempts = await bumpInboxAttempts(layout, inbox);
      if (attempts >= options.maxAttempts) {
        const dest = await moveToQuarantine(layout, inbox);
        quarantined.push(dest);
        progressed = true;
      }
    }

    // Delete done inboxes (script-owned)
    for (const item of acceptance.done) {
      await deleteInboxFile(layout, item.inbox);
      deletedInbox.push(item.inbox);
      progressed = true;
    }

    const researchInboxSnapshot = await snapshotInbox(layout);
    const research = await runResearchStage({
      layout,
      maxResearchPerRound: options.maxResearchPerRound,
      runner: deps.researchRunner,
      clock,
      retryFailedResearch,
    });
    researchProcessed = research.processed;
    researchPending = research.pending;
    const inboxSafetyError = await verifyResearchInboxUnchanged(
      layout,
      researchInboxSnapshot,
    );
    const contentProgressed = deletedInbox.length > 0 || quarantined.length > 0;
    const roundProgressed = contentProgressed || research.progressed;
    progressed = roundProgressed;
    const roundStatus = research.error ? "failed" : "success";
    const roundDetail = research.error
      ? research.error
      : `done=${deletedInbox.length} quarantine=${quarantined.length} ${researchDetail(research)}`;

    await writeStateSafe(
      layout,
      stateBody(clock, inboxSafetyError ? "failed" : roundStatus, roundDetail, {
        phase: "research",
        inboxPending: (await listPendingInbox(layout)).length,
        researchPending: research.pending,
        ...(inboxSafetyError || research.error
          ? { lastError: inboxSafetyError ?? research.error }
          : {}),
      }),
    );

    if (inboxSafetyError) {
      return {
        status: "failed",
        reason: inboxSafetyError,
        deletedInbox,
        quarantined,
        agentInvoked: true,
        progressed: roundProgressed,
        researchProcessed: research.processed,
        researchPending: research.pending,
      };
    }

    const finalChanges = await workspace.listChanges();
    const unauthorized = findUnauthorizedChange(finalChanges, layout);
    if (unauthorized) {
      const recoveryErrors = await restoreUnauthorizedChanges(
        workspace,
        finalChanges,
        layout,
      );
      const reason = appendRecoveryErrors(unauthorized, recoveryErrors);
      await writeStateSafe(
        layout,
        stateBody(clock, "failed", reason, {
          phase: "publish",
          inboxPending: (await listPendingInbox(layout)).length,
          researchPending: research.pending,
          lastError: reason,
        }),
      );
      return {
        status: "failed",
        reason,
        deletedInbox,
        quarantined,
        agentInvoked: true,
        progressed: roundProgressed,
        researchProcessed: research.processed,
        researchPending: research.pending,
      };
    }

    const published = await publishChanges(
      publisher,
      finalChanges,
      buildCommitMessage(deletedInbox, quarantined, clock),
      layout,
      clock,
    );
    if (published) {
      return {
        status: published.status,
        reason: published.reason,
        deletedInbox,
        quarantined,
        agentInvoked: true,
        progressed: roundProgressed,
        researchProcessed: research.processed,
        researchPending: research.pending,
      };
    }

    if (research.error) {
      return {
        status: "failed",
        reason: research.error,
        deletedInbox,
        quarantined,
        agentInvoked: true,
        progressed: roundProgressed,
        researchProcessed: research.processed,
        researchPending: research.pending,
      };
    }

    const result = {
      status: "success",
      deletedInbox,
      quarantined,
      agentInvoked: true,
      progressed: roundProgressed,
      researchProcessed: research.processed,
      researchPending: research.pending,
    } as const;
    logInfo("processor.round_finished", result);
    return result;
  } catch (error) {
    const reason = errorMessage(error);
    logError("processor.round_failed", { reason });
    const stateFailure = await writeFailureState(layout, clock, reason);
    return {
      status: "failed",
      reason: stateFailure ? `${reason}; ${stateFailure}` : reason,
      deletedInbox,
      quarantined,
      agentInvoked,
      progressed,
      researchProcessed,
      researchPending,
    };
  } finally {
    await handle.release();
  }
}

function stateBody(
  clock: Clock,
  status: string,
  detail: string,
  meta: {
    phase?: string;
    inboxPending?: number;
    researchPending?: number;
    lastError?: string;
  } = {},
): string {
  const now = clock.now().toISOString();
  return [
    "# Processor STATE",
    "",
    `- updated_at: ${now}`,
    `- status: ${status}`,
    `- phase: ${meta.phase ?? "unknown"}`,
    `- inbox_pending: ${meta.inboxPending ?? "unknown"}`,
    `- research_pending: ${meta.researchPending ?? "unknown"}`,
    `- last_error: ${meta.lastError ?? "none"}`,
    `- detail: ${detail}`,
    "",
  ].join("\n");
}

async function writeStateSafe(
  layout: ProcessorOptions["layout"],
  body: string,
): Promise<void> {
  try {
    await writeState(layout, body);
  } catch (error) {
    const reason = `STATE 写回失败: ${errorMessage(error)}`;
    logError("processor.state_write_failed", { reason });
    throw new Error(reason, { cause: error });
  }
}

async function writeFailureState(
  layout: ProcessorOptions["layout"],
  clock: Clock,
  reason: string,
): Promise<string | undefined> {
  try {
    await writeState(
      layout,
      stateBody(clock, "failed", reason, {
        phase: "unknown",
        lastError: reason,
      }),
    );
    return undefined;
  } catch (error) {
    const stateReason = `STATE 写回失败: ${errorMessage(error)}`;
    logError("processor.state_write_failed", { reason: stateReason });
    return stateReason;
  }
}

function buildCommitMessage(
  deleted: string[],
  quarantined: string[],
  clock: Clock,
): string {
  return `processor: done=${deleted.length} quarantine=${quarantined.length} @ ${clock.now().toISOString()}`;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function changedPathNames(change: {
  path: string;
  previousPath?: string;
}): string[] {
  return change.previousPath === undefined
    ? [change.path]
    : [change.path, change.previousPath];
}

function findUnauthorizedChange(
  changes: { path: string; previousPath?: string }[],
  layout: ProcessorOptions["layout"],
): string | undefined {
  for (const change of changes) {
    for (const changedPath of changedPathNames(change)) {
      if (!isWhitelistedPath(changedPath, layout)) {
        return `提交前发现白名单外路径: ${changedPath}`;
      }
    }
  }
  return undefined;
}

async function restoreUnauthorizedChanges(
  workspace: VaultWorkspace,
  changes: { path: string; previousPath?: string }[],
  layout: ProcessorOptions["layout"],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const change of changes) {
    const names = changedPathNames(change);
    if (names.some((changedPath) => !isWhitelistedPath(changedPath, layout))) {
      for (const name of names) paths.add(name);
    }
  }
  return restorePaths(workspace, [...paths]);
}

async function restorePaths(
  workspace: VaultWorkspace,
  paths: string[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const relative of paths) {
    try {
      await workspace.restore(relative);
    } catch (error) {
      const reason = relative + ": " + errorMessage(error);
      logError("processor.restore_failed", { path: relative, reason });
      errors.push(reason);
    }
  }
  return errors;
}

function appendRecoveryErrors(reason: string, errors: string[]): string {
  return errors.length > 0
    ? reason + "; 恢复失败: " + errors.join("; ")
    : reason;
}

function createRoundId(clock: Clock): string {
  return `${clock.now().toISOString()}-${randomUUID()}`;
}

async function publishChanges(
  publisher: VaultPublisher | undefined,
  changes: { path: string; previousPath?: string }[],
  message: string,
  layout: ProcessorOptions["layout"],
  clock: Clock,
): Promise<{ status: "failed" | "conflict"; reason: string } | undefined> {
  if (!publisher) return undefined;
  const paths = unique(changes.flatMap(changedPathNames));
  if (paths.length === 0) return undefined;

  const published = await publisher.publish(paths, message);
  if (published.ok) return undefined;

  const reason = published.reason ?? "vault 发布失败";
  const status = published.conflict ? "conflict" : "failed";
  logError("processor.publish_failed", {
    reason,
    conflict: published.conflict ?? false,
  });
  await writeStateSafe(
    layout,
    stateBody(clock, status, reason, {
      phase: "publish",
      lastError: reason,
    }),
  );
  return { status, reason };
}

type InboxSnapshot = Map<string, Buffer>;

async function snapshotInbox(
  layout: ProcessorOptions["layout"],
): Promise<InboxSnapshot> {
  const snapshot: InboxSnapshot = new Map();
  await collectInboxFiles(
    path.join(layout.vaultPath, layout.inboxDir),
    "",
    snapshot,
  );
  return snapshot;
}

async function collectInboxFiles(
  absoluteDir: string,
  relativeDir: string,
  snapshot: InboxSnapshot,
): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    const absolute = path.join(absoluteDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`inbox 包含符号链接: ${relative}`);
    }
    if (entry.isDirectory()) {
      await collectInboxFiles(absolute, relative, snapshot);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`inbox 包含非普通文件: ${relative}`);
    }
    snapshot.set(relative, await readFile(absolute));
  }
}

async function verifyResearchInboxUnchanged(
  layout: ProcessorOptions["layout"],
  before: InboxSnapshot,
): Promise<string | undefined> {
  let after: InboxSnapshot;
  try {
    after = await snapshotInbox(layout);
  } catch (error) {
    try {
      await removeNonRegularInboxEntries(
        path.join(layout.vaultPath, layout.inboxDir),
      );
      await restoreInboxSnapshot(layout, before);
    } catch (restoreError) {
      const reason =
        `研究阶段无法检查 inbox，且恢复失败: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
      logError("processor.inbox_restore_failed", { reason });
      return reason;
    }
    return `研究阶段修改了 inbox 非普通文件，已恢复原始收件项: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (sameSnapshot(before, after)) return undefined;

  try {
    await restoreInboxSnapshot(layout, before);
  } catch (error) {
    const reason =
      `研究阶段修改 inbox，且恢复失败: ${error instanceof Error ? error.message : String(error)}`;
    logError("processor.inbox_restore_failed", { reason });
    return reason;
  }
  return "研究阶段不得修改 inbox，已恢复原始收件项";
}

function sameSnapshot(a: InboxSnapshot, b: InboxSnapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [relative, content] of a) {
    const current = b.get(relative);
    if (current === undefined || !content.equals(current)) return false;
  }
  return true;
}

async function restoreInboxSnapshot(
  layout: ProcessorOptions["layout"],
  expected: InboxSnapshot,
): Promise<void> {
  const root = path.join(layout.vaultPath, layout.inboxDir);
  await removeNonRegularInboxEntries(root);
  const current = await snapshotInbox(layout);
  for (const relative of current.keys()) {
    if (!expected.has(relative)) {
      await rm(path.join(root, relative), { force: true });
    }
  }
  for (const [relative, content] of expected) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function removeNonRegularInboxEntries(absoluteDir: string): Promise<void> {
  await mkdir(absoluteDir, { recursive: true });
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    if (entry.isSymbolicLink()) {
      await rm(absolute, { force: true, recursive: true });
      continue;
    }
    if (entry.isDirectory()) {
      await removeNonRegularInboxEntries(absolute);
      continue;
    }
    if (!entry.isFile()) {
      await rm(absolute, { force: true, recursive: true });
    }
  }
}

async function commitWorkingTreeBestEffort(
  workspace: VaultWorkspace,
  publisher: VaultPublisher | undefined,
  layout: ProcessorOptions["layout"],
  message: string,
): Promise<string | undefined> {
  if (!publisher) return undefined;
  try {
    const changes = await workspace.listChanges();
    const safe = changes.filter((change) =>
      changedPathNames(change).every((changedPath) =>
        isFailurePublishPath(changedPath, layout),
      ),
    );
    const paths = unique(safe.flatMap(changedPathNames));
    if (paths.length === 0) return undefined;
    const published = await publisher.publish(paths, message);
    if (published.ok) return undefined;
    const reason = published.reason ?? "失败路径发布失败";
    logError("processor.failure_publish_failed", {
      reason,
      conflict: published.conflict ?? false,
    });
    return "失败路径发布失败: " + reason;
  } catch (error) {
    const reason = "失败路径发布失败: " + errorMessage(error);
    logError("processor.failure_publish_failed", { reason });
    return reason;
  }
}

function isFailurePublishPath(
  changedPath: string,
  layout: ProcessorOptions["layout"],
): boolean {
  if (!isWhitelistedPath(changedPath, layout)) return false;
  const normalized = changedPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  const inbox = layout.inboxDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const quarantine = layout.quarantineDir
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const isInboxPath = normalized === inbox || normalized.startsWith(inbox + "/");
  if (!isInboxPath) return true;
  return normalized === quarantine || normalized.startsWith(quarantine + "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
