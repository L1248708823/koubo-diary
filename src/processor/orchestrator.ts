import path from "node:path";
import type {
  AgentRunner,
  Clock,
  GitOps,
  Lock,
  ProcessorOptions,
  RoundResult,
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

export type ProcessorDeps = {
  options: ProcessorOptions;
  git: GitOps;
  lock: Lock;
  agent: AgentRunner;
  clock: Clock;
};

export async function runProcessorRound(deps: ProcessorDeps): Promise<RoundResult> {
  const { options, git, lock, agent, clock } = deps;
  const layout = options.layout;

  const handle = await lock.tryAcquire();
  if (!handle) {
    return {
      status: "locked",
      reason: "单实例锁已被占用",
      deletedInbox: [],
      quarantined: [],
      agentInvoked: false,
    };
  }

  try {
    const pull = await git.pull();
    if (!pull.ok) {
      await writeStateSafe(
        layout,
        stateBody(clock, "conflict", pull.reason ?? "git pull 失败"),
      );
      return {
        status: pull.conflict ? "conflict" : "failed",
        reason: pull.reason ?? "git pull 失败",
        deletedInbox: [],
        quarantined: [],
        agentInvoked: false,
      };
    }

    const allPending = await listPendingInbox(layout);
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

    await agent.run({
      vaultPath: layout.vaultPath,
      layout,
      maxPerRound: options.maxPerRound,
      pendingInbox,
    });

    const changes = await git.listChanges();
    const acceptance = await acceptRound({
      layout,
      snapshotInbox,
      changes,
    });

    if (!acceptance.ok) {
      // Try restore unauthorized deletes
      for (const p of acceptance.unauthorizedDeletes) {
        try {
          await git.restoreFromHead(p);
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

    const finalChanges = await git.listChanges();
    for (const ch of finalChanges) {
      const { isWhitelistedPath } = await import("../config.js");
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

    const pathsToAdd = unique(finalChanges.map((c) => c.path));
    if (pathsToAdd.length > 0) {
      await git.add(pathsToAdd);
    }

    const commitMsg = buildCommitMessage(deletedInbox, quarantined, clock);
    const committed = await git.commit(commitMsg);
    if (!committed.ok) {
      await writeStateSafe(
        layout,
        stateBody(clock, "failed", committed.reason ?? "commit 失败"),
      );
      return {
        status: "failed",
        reason: committed.reason ?? "commit 失败",
        deletedInbox,
        quarantined,
        agentInvoked: true,
      };
    }

    const pushed = await git.push();
    if (!pushed.ok) {
      await writeStateSafe(
        layout,
        stateBody(
          clock,
          pushed.conflict ? "conflict" : "failed",
          pushed.reason ?? "push 失败",
        ),
      );
      return {
        status: pushed.conflict ? "conflict" : "failed",
        reason: pushed.reason ?? "push 失败",
        deletedInbox,
        quarantined,
        agentInvoked: true,
      };
    }

    return {
      status: "success",
      deletedInbox,
      quarantined,
      agentInvoked: true,
    };
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
