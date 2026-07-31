import path from "node:path";
import type {
  AgentRunner,
  Clock,
  Lock,
  ProcessorOptions,
  RoundResult,
  VaultPublisher,
  VaultWorkspace,
} from "../types.js";
import {
  bumpInboxAttempts,
  deleteInboxFile,
  listPendingInbox,
  moveToQuarantine,
  pathExists,
  writeState,
} from "../vault/fs.js";
import { acceptRound } from "./accept.js";
import { isWhitelistedPath } from "../config.js";
import { logError, logInfo } from "../runtime/log.js";

export type ProcessorDeps = {
  options: ProcessorOptions;
  workspace: VaultWorkspace;
  publisher?: VaultPublisher;
  lock: Lock;
  agent: AgentRunner;
  clock: Clock;
};

export async function runProcessorRound(deps: ProcessorDeps): Promise<RoundResult> {
  const { options, workspace, publisher, lock, agent, clock } = deps;
  const layout = options.layout;
  logInfo("processor.round_started", {
    vaultPath: layout.vaultPath,
    publisher: Boolean(publisher),
    maxPerRound: options.maxPerRound,
  });

  const handle = await lock.tryAcquire();
  if (!handle) {
    logInfo("processor.round_locked", { vaultPath: layout.vaultPath });
    return {
      status: "locked",
      reason: "单实例锁已被占用",
      deletedInbox: [],
      quarantined: [],
      agentInvoked: false,
    };
  }

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
        ),
      );
      return {
        status: prepared.conflict ? "conflict" : "failed",
        reason: prepared.reason ?? "准备 vault 工作区失败",
        deletedInbox: [],
        quarantined: [],
        agentInvoked: false,
      };
    }

    const allPending = await listPendingInbox(layout);
    logInfo("processor.inbox_scanned", {
      pending: allPending.length,
      selected: Math.min(allPending.length, options.maxPerRound),
    });
    if (allPending.length === 0) {
      await writeStateSafe(layout, stateBody(clock, "empty", "收件箱无待处理"));
      return {
        status: "empty",
        reason: "收件箱无待处理",
        deletedInbox: [],
        quarantined: [],
        agentInvoked: false,
      };
    }

    const pendingInbox = allPending.slice(0, options.maxPerRound);
    const snapshotInbox = [...pendingInbox];

    logInfo("processor.agent_started", { count: pendingInbox.length });
    try {
      await agent.run({
        vaultPath: layout.vaultPath,
        layout,
        maxPerRound: options.maxPerRound,
        pendingInbox,
      });
    } catch (error) {
      logError("processor.agent_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logInfo("processor.agent_finished", { count: pendingInbox.length });

    const changes = await workspace.listChanges();
    const acceptance = await acceptRound({
      layout,
      snapshotInbox,
      changes,
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
      // Try restore unauthorized deletes
      for (const p of acceptance.unauthorizedDeletes) {
        try {
          await workspace.restore(p);
        } catch {
          /* best effort */
        }
      }
      // 验收失败：不删 inbox；对快照内仍在的条目 attempts+1，触顶则隔离
      const quarantinedOnFail: string[] = [];
      for (const inbox of snapshotInbox) {
        if (!(await pathExists(path.join(layout.vaultPath, inbox)))) continue;
        try {
          const attempts = await bumpInboxAttempts(layout, inbox);
          if (attempts >= options.maxAttempts) {
            const dest = await moveToQuarantine(layout, inbox);
            quarantinedOnFail.push(dest);
          }
        } catch {
          /* best effort */
        }
      }
      await writeStateSafe(
        layout,
        stateBody(clock, "failed", acceptance.reason),
      );
      // 失败也尽量把 attempts / 隔离 / STATE 提交进去，避免下轮丢计数
      await commitWorkingTreeBestEffort(
        workspace,
        publisher,
        layout,
        `processor: failed ${acceptance.reason}`.slice(0, 200),
      );
      return {
        status: "failed",
        reason: acceptance.reason,
        deletedInbox: [],
        quarantined: quarantinedOnFail,
        agentInvoked: true,
      };
    }

    const deletedInbox: string[] = [];
    const quarantined: string[] = [];

    // Handle explicit quarantine from receipt
    for (const inbox of acceptance.quarantineInboxes) {
      if (await pathExists(path.join(layout.vaultPath, inbox))) {
        const dest = await moveToQuarantine(layout, inbox);
        quarantined.push(dest);
      }
    }

    // Handle failures: bump attempts, maybe quarantine
    for (const inbox of acceptance.failedInboxes) {
      if (!(await pathExists(path.join(layout.vaultPath, inbox)))) continue;
      const attempts = await bumpInboxAttempts(layout, inbox);
      if (attempts >= options.maxAttempts) {
        const dest = await moveToQuarantine(layout, inbox);
        quarantined.push(dest);
      }
    }

    // Delete done inboxes (script-owned)
    for (const item of acceptance.done) {
      await deleteInboxFile(layout, item.inbox);
      deletedInbox.push(item.inbox);
    }

    await writeStateSafe(
      layout,
      stateBody(
        clock,
        "success",
        `done=${deletedInbox.length} quarantine=${quarantined.length}`,
      ),
    );

    const finalChanges = await workspace.listChanges();
    for (const ch of finalChanges) {
      if (!isWhitelistedPath(ch.path, layout)) {
        await writeStateSafe(
          layout,
          stateBody(clock, "failed", `提交前发现白名单外路径: ${ch.path}`),
        );
        return {
          status: "failed",
          reason: `白名单外路径变更: ${ch.path}`,
          deletedInbox: [],
          quarantined,
          agentInvoked: true,
        };
      }
    }

    const commitMsg = buildCommitMessage(deletedInbox, quarantined, clock);
    if (publisher) {
      const pathsToPublish = unique(finalChanges.map((c) => c.path));
      const published = await publisher.publish(pathsToPublish, commitMsg);
      if (!published.ok) {
        logError("processor.publish_failed", {
          reason: published.reason,
          conflict: published.conflict ?? false,
        });
        await writeStateSafe(
          layout,
          stateBody(
            clock,
            published.conflict ? "conflict" : "failed",
            published.reason ?? "vault 发布失败",
          ),
        );
        return {
          status: published.conflict ? "conflict" : "failed",
          reason: published.reason ?? "vault 发布失败",
          deletedInbox,
          quarantined,
          agentInvoked: true,
        };
      }
    }

    const result = {
      status: "success",
      deletedInbox,
      quarantined,
      agentInvoked: true,
    } as const;
    logInfo("processor.round_finished", result);
    return result;
  } finally {
    await handle.release();
  }
}

function stateBody(
  clock: Clock,
  status: string,
  detail: string,
): string {
  const now = clock.now().toISOString();
  return [
    "# Processor STATE",
    "",
    `- updated_at: ${now}`,
    `- status: ${status}`,
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
  } catch {
    /* non-fatal */
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

async function commitWorkingTreeBestEffort(
  workspace: VaultWorkspace,
  publisher: VaultPublisher | undefined,
  layout: ProcessorOptions["layout"],
  message: string,
): Promise<void> {
  if (!publisher) return;
  try {
    const changes = await workspace.listChanges();
    const safe = changes.filter((c) => isWhitelistedPath(c.path, layout));
    if (safe.length === 0) return;
    await publisher.publish(safe.map((c) => c.path), message);
  } catch {
    /* 失败路径的提交是尽力而为 */
  }
}
