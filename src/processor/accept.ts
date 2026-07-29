import path from "node:path";
import { isWhitelistedPath } from "../config.js";
import type {
  ChangedPath,
  Receipt,
  ReceiptItemDone,
  VaultLayout,
} from "../types.js";
import {
  pathExists,
  readReceipt,
} from "../vault/fs.js";

export type AcceptanceOk = {
  ok: true;
  done: ReceiptItemDone[];
  failedInboxes: string[];
  quarantineInboxes: string[];
};

export type AcceptanceFail = {
  ok: false;
  reason: string;
  unauthorizedDeletes: string[];
};

export type AcceptanceResult = AcceptanceOk | AcceptanceFail;

function isInboxPath(p: string, layout: VaultLayout): boolean {
  const n = p.replace(/\\/g, "/");
  const prefix = layout.inboxDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const qprefix =
    layout.quarantineDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (n.startsWith(qprefix)) return false;
  return n.startsWith(prefix) && n.endsWith(".md");
}

export async function acceptRound(args: {
  layout: VaultLayout;
  snapshotInbox: string[];
  changes: ChangedPath[];
}): Promise<AcceptanceResult> {
  const { layout, snapshotInbox, changes } = args;
  const rawReceipt = await readReceipt(layout);
  if (!rawReceipt) {
    return { ok: false, reason: "缺少回执 last-run.json", unauthorizedDeletes: [] };
  }
  if (!isValidReceiptShape(rawReceipt)) {
    return { ok: false, reason: "回执 JSON 结构不合法", unauthorizedDeletes: [] };
  }
  const receipt: Receipt = rawReceipt;

  // Whitelist
  for (const ch of changes) {
    if (!isWhitelistedPath(ch.path, layout)) {
      return {
        ok: false,
        reason: `白名单外路径变更: ${ch.path}`,
        unauthorizedDeletes: [],
      };
    }
  }

  const declaredDone = new Set(
    receipt.processed.map((p: ReceiptItemDone) => normalize(p.inbox)),
  );
  const declaredFailed = new Set(
    receipt.failed.map((p) => normalize(p.inbox)),
  );
  const declaredQuarantine = new Set(
    receipt.quarantine.map((p) => normalize(p.inbox)),
  );
  const authorizedDelete = new Set<string>([...declaredDone]);

  // Unauthorized inbox deletes: deleted in working tree, was in snapshot, not in done list
  const unauthorizedDeletes: string[] = [];
  for (const ch of changes) {
    if (ch.status !== "D") continue;
    if (!isInboxPath(ch.path, layout)) continue;
    const n = normalize(ch.path);
    if (!snapshotInbox.map(normalize).includes(n)) continue;
    if (!authorizedDelete.has(n)) {
      unauthorizedDeletes.push(n);
    }
  }
  // Also: snapshot inbox missing on disk but not declared done (agent deleted without D in diff edge cases)
  for (const inbox of snapshotInbox) {
    const n = normalize(inbox);
    const abs = path.join(layout.vaultPath, inbox);
    const exists = await pathExists(abs);
    if (!exists && !authorizedDelete.has(n) && !declaredQuarantine.has(n)) {
      if (!unauthorizedDeletes.includes(n)) unauthorizedDeletes.push(n);
    }
  }

  if (unauthorizedDeletes.length > 0) {
    return {
      ok: false,
      reason: `回执未授权的 inbox 删除: ${unauthorizedDeletes.join(", ")}`,
      unauthorizedDeletes,
    };
  }

  // done consistency
  for (const item of receipt.processed) {
    if (item.status !== "done") {
      return { ok: false, reason: "processed 中存在非 done 状态", unauthorizedDeletes: [] };
    }
    if (!item.diary) {
      return {
        ok: false,
        reason: `done 缺 diary: ${item.inbox}`,
        unauthorizedDeletes: [],
      };
    }
    const diaryAbs = path.join(layout.vaultPath, item.diary);
    if (!(await pathExists(diaryAbs))) {
      return {
        ok: false,
        reason: `done 但缺 diary 文件: ${item.diary}`,
        unauthorizedDeletes: [],
      };
    }
    if (item.idea) {
      const ideaAbs = path.join(layout.vaultPath, item.idea);
      if (!(await pathExists(ideaAbs))) {
        return {
          ok: false,
          reason: `done 声明了 idea 但文件不存在: ${item.idea}`,
          unauthorizedDeletes: [],
        };
      }
    }
    // inbox must still exist pre-script-delete
    const inboxAbs = path.join(layout.vaultPath, item.inbox);
    if (!(await pathExists(inboxAbs))) {
      return {
        ok: false,
        reason: `done 项的 inbox 在脚本删除前已不存在: ${item.inbox}`,
        unauthorizedDeletes: [],
      };
    }
    if (!snapshotInbox.map(normalize).includes(normalize(item.inbox))) {
      return {
        ok: false,
        reason: `done 项不在跑前快照中: ${item.inbox}`,
        unauthorizedDeletes: [],
      };
    }
  }

  // failed items must still exist
  for (const item of receipt.failed) {
    const abs = path.join(layout.vaultPath, item.inbox);
    if (!(await pathExists(abs))) {
      return {
        ok: false,
        reason: `failed 项 inbox 不应被删除: ${item.inbox}`,
        unauthorizedDeletes: [],
      };
    }
  }

  // Empty success: still have pending-like snapshot items with no done/failed/quarantine
  const accounted = new Set([
    ...declaredDone,
    ...declaredFailed,
    ...declaredQuarantine,
  ]);
  const unaccounted = snapshotInbox
    .map(normalize)
    .filter((p) => !accounted.has(p));
  // Only flag if agent was expected to process them — we pass the capped list as snapshot.
  // If there are unaccounted items that still exist, it's an abnormal round.
  if (
    unaccounted.length > 0 &&
    receipt.processed.length === 0 &&
    receipt.failed.length === 0 &&
    receipt.quarantine.length === 0
  ) {
    return {
      ok: false,
      reason: "仍有待处理却无 done/failed/quarantine（异常轮）",
      unauthorizedDeletes: [],
    };
  }

  return {
    ok: true,
    done: receipt.processed,
    failedInboxes: receipt.failed.map((f) => f.inbox),
    quarantineInboxes: receipt.quarantine.map((q) => q.inbox),
  };
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function isValidReceiptShape(r: unknown): r is Receipt {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return false;
  if (typeof obj.round_ended_at !== "string") return false;
  if (!Array.isArray(obj.processed) || !Array.isArray(obj.failed) || !Array.isArray(obj.quarantine)) {
    return false;
  }
  for (const p of obj.processed) {
    if (!p || typeof p !== "object") return false;
    const item = p as Record<string, unknown>;
    if (typeof item.inbox !== "string" || item.status !== "done") return false;
  }
  for (const p of obj.failed) {
    if (!p || typeof p !== "object") return false;
    const item = p as Record<string, unknown>;
    if (typeof item.inbox !== "string" || item.status !== "failed") return false;
  }
  for (const p of obj.quarantine) {
    if (!p || typeof p !== "object") return false;
    const item = p as Record<string, unknown>;
    if (typeof item.inbox !== "string" || item.status !== "quarantine") return false;
  }
  return true;
}
