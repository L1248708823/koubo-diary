import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  isDiaryPath,
  isIdeaPath,
  isResearchPath,
  isWhitelistedPath,
} from "../config.js";
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
  /** All paths that must be restored or removed after an unsafe change. */
  recoveryPaths: string[];
};

export type AcceptanceResult = AcceptanceOk | AcceptanceFail;

function isAgentOwnedInboxPath(p: string, layout: VaultLayout): boolean {
  const normalized = normalize(p);
  const prefix = layout.inboxDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return normalized.startsWith(prefix);
}

async function findRecoveryPaths(
  layout: VaultLayout,
  snapshotInbox: string[],
  changes: ChangedPath[],
): Promise<string[]> {
  const paths: string[] = [];
  const snapshotSet = new Set(snapshotInbox.map(normalize));
  for (const change of changes) {
    for (const changedPath of changedPathNames(change)) {
      if (
        !isWhitelistedPath(changedPath, layout) ||
        (isAgentOwnedInboxPath(changedPath, layout) &&
          !(await isConcurrentInboxAddition(
            change,
            changedPath,
            layout,
            snapshotSet,
          )))
      ) {
        paths.push(changedPath);
      }
    }
  }

  for (const inbox of snapshotInbox) {
    if (!(await pathExists(path.join(layout.vaultPath, inbox)))) {
      paths.push(inbox);
    }
  }

  return unique(paths.map(normalize));
}

async function isConcurrentInboxAddition(
  change: ChangedPath,
  changedPath: string,
  layout: VaultLayout,
  snapshotInbox: Set<string>,
): Promise<boolean> {
  if (
    change.previousPath !== undefined ||
    (!change.status.startsWith("A") && !change.status.includes("?"))
  ) {
    return false;
  }
  const normalized = normalize(changedPath);
  const inboxPrefix = normalize(layout.inboxDir).replace(/\/+$/, "") + "/";
  if (!normalized.startsWith(inboxPrefix) || snapshotInbox.has(normalized)) {
    return false;
  }
  const relative = normalized.slice(inboxPrefix.length);
  if (relative.includes("/") || !relative.endsWith(".md")) return false;

  // 捕捉端写入的 id 必须等于文件名主体，用它排除 agent 重命名旧收件项。
  let body: string;
  try {
    body = await readFile(path.join(layout.vaultPath, normalized), "utf8");
  } catch {
    return false;
  }
  const id = body.match(/^id:[ \t]*(\S+)[ \t]*$/m)?.[1];
  return id === relative.slice(0, -3);
}

function unsafeChangeFailure(
  layout: VaultLayout,
  recoveryPaths: string[],
): AcceptanceFail {
  const inboxPath = recoveryPaths.find((p) => isAgentOwnedInboxPath(p, layout));
  return {
    ok: false,
    reason: inboxPath
      ? `agent 不得修改 inbox: ${inboxPath}`
      : `白名单外路径变更: ${recoveryPaths[0]}`,
    recoveryPaths,
  };
}

function rejection(reason: string): AcceptanceFail {
  return { ok: false, reason, recoveryPaths: [] };
}

export async function acceptRound(args: {
  layout: VaultLayout;
  snapshotInbox: string[];
  changes: ChangedPath[];
  roundId: string;
}): Promise<AcceptanceResult> {
  const { layout, snapshotInbox, changes, roundId } = args;
  const recoveryPaths = await findRecoveryPaths(layout, snapshotInbox, changes);
  if (recoveryPaths.length > 0) {
    return unsafeChangeFailure(layout, recoveryPaths);
  }

  const rawReceipt = await readReceipt(layout);
  if (!rawReceipt) {
    return rejection("缺少回执 last-run.json");
  }
  if (!isValidReceiptShape(rawReceipt)) {
    return rejection("回执 JSON 结构不合法");
  }
  const receipt: Receipt = rawReceipt;
  if (receipt.round_id !== roundId) {
    return rejection(`回执 round_id 不匹配: ${receipt.round_id}`);
  }
  const duplicateInbox = findDuplicateInbox(receipt);
  if (duplicateInbox) {
    return rejection(`回执重复交代 inbox: ${duplicateInbox}`);
  }
  const duplicateIdea = findDuplicateIdea(receipt);
  if (duplicateIdea) {
    return rejection(`回执重复使用 idea: ${duplicateIdea}`);
  }
  const snapshotSet = new Set(snapshotInbox.map(normalize));
  const outOfRoundInbox = findOutOfRoundInbox(receipt, snapshotSet);
  if (outOfRoundInbox) {
    return rejection(`回执项不在本轮快照: ${outOfRoundInbox}`);
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
  // done consistency
  for (const item of receipt.processed) {
    if (item.status !== "done") {
      return rejection("processed 中存在非 done 状态");
    }
    if (typeof item.diary !== "string" || !item.diary) {
      return rejection(`done 缺 diary: ${item.inbox}`);
    }
    if (!isDiaryPath(item.diary, layout)) {
      return rejection(`diary 路径必须位于 ${layout.diaryDir}/ 下: ${item.diary}`);
    }
    const diaryAbs = path.join(layout.vaultPath, item.diary);
    if (!(await pathExists(diaryAbs))) {
      return rejection(`done 但缺 diary 文件: ${item.diary}`);
    }
    if (item.idea !== undefined) {
      if (!isIdeaPath(item.idea, layout)) {
        return rejection(`idea 路径必须是 ${layout.ideasDir}/文件名.md: ${item.idea}`);
      }
      const ideaAbs = path.join(layout.vaultPath, item.idea);
      if (!(await pathExists(ideaAbs))) {
        return rejection(`done 声明了 idea 但文件不存在: ${item.idea}`);
      }
    }
    // inbox must still exist pre-script-delete
    const inboxAbs = path.join(layout.vaultPath, item.inbox);
    if (!(await pathExists(inboxAbs))) {
      return rejection(`done 项的 inbox 在脚本删除前已不存在: ${item.inbox}`);
    }
    if (!snapshotSet.has(normalize(item.inbox))) {
      return rejection(`done 项不在跑前快照中: ${item.inbox}`);
    }
  }

  // failed items must still exist
  for (const item of receipt.failed) {
    const abs = path.join(layout.vaultPath, item.inbox);
    if (!(await pathExists(abs))) {
      return rejection(`failed 项 inbox 不应被删除: ${item.inbox}`);
    }
  }

  // 本轮快照内每条都必须在回执里交代；漏报视为异常轮（不静默成功）
  const accounted = new Set([
    ...declaredDone,
    ...declaredFailed,
    ...declaredQuarantine,
  ]);
  const unaccounted = snapshotInbox
    .map(normalize)
    .filter((p) => !accounted.has(p));
  if (unaccounted.length > 0) {
    return rejection(`仍有待处理未在回执交代: ${unaccounted.join(", ")}`);
  }

  const researchLinkError = await validateChangedResearchLinks(
    layout,
    receipt.processed,
    changes,
  );
  if (researchLinkError) return rejection(researchLinkError);

  return {
    ok: true,
    done: receipt.processed,
    failedInboxes: receipt.failed.map((f) => f.inbox),
    quarantineInboxes: receipt.quarantine.map((q) => q.inbox),
  };
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function changedPathNames(change: ChangedPath): string[] {
  return change.previousPath === undefined
    ? [change.path]
    : [change.path, change.previousPath];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isValidReceiptShape(r: unknown): r is Receipt {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return false;
  if (typeof obj.round_id !== "string" || obj.round_id.length === 0) return false;
  if (typeof obj.round_ended_at !== "string") return false;
  if (!Array.isArray(obj.processed) || !Array.isArray(obj.failed) || !Array.isArray(obj.quarantine)) {
    return false;
  }
  for (const p of obj.processed) {
    if (!p || typeof p !== "object") return false;
    const item = p as Record<string, unknown>;
    if (
      typeof item.inbox !== "string" ||
      item.status !== "done" ||
      typeof item.diary !== "string" ||
      (item.idea !== undefined && typeof item.idea !== "string")
    ) {
      return false;
    }
  }
  for (const p of obj.failed) {
    if (!p || typeof p !== "object") return false;
    const item = p as Record<string, unknown>;
    if (
      typeof item.inbox !== "string" ||
      item.status !== "failed" ||
      typeof item.error !== "string"
    ) {
      return false;
    }
  }
  for (const p of obj.quarantine) {
    if (!p || typeof p !== "object") return false;
    const item = p as Record<string, unknown>;
    if (
      typeof item.inbox !== "string" ||
      item.status !== "quarantine" ||
      (item.error !== undefined && typeof item.error !== "string")
    ) {
      return false;
    }
  }
  return true;
}

function findDuplicateInbox(receipt: Receipt): string | null {
  const seen = new Set<string>();
  for (const inbox of receiptInboxes(receipt)) {
    const normalized = normalize(inbox);
    if (seen.has(normalized)) return normalized;
    seen.add(normalized);
  }
  return null;
}

function findDuplicateIdea(receipt: Receipt): string | null {
  const seen = new Set<string>();
  for (const item of receipt.processed) {
    if (item.idea === undefined) continue;
    const normalized = normalize(item.idea);
    if (seen.has(normalized)) return normalized;
    seen.add(normalized);
  }
  return null;
}

function findOutOfRoundInbox(
  receipt: Receipt,
  snapshotInbox: Set<string>,
): string | null {
  return receiptInboxes(receipt).find((inbox) => !snapshotInbox.has(normalize(inbox))) ?? null;
}

function receiptInboxes(receipt: Receipt): string[] {
  return [
    ...receipt.processed.map((item) => item.inbox),
    ...receipt.failed.map((item) => item.inbox),
    ...receipt.quarantine.map((item) => item.inbox),
  ];
}

async function validateChangedResearchLinks(
  layout: VaultLayout,
  processed: ReceiptItemDone[],
  changes: ChangedPath[],
): Promise<string | undefined> {
  const changedPaths = new Set(
    changes.flatMap(changedPathNames).map(normalize),
  );
  const sourcePaths = unique(
    processed
      .flatMap((item) => [item.diary, ...(item.idea ? [item.idea] : [])])
      .filter(
        (relative) =>
          changedPaths.has(normalize(relative)) &&
          (isDiaryPath(relative, layout) || isIdeaPath(relative, layout)),
      ),
  );
  const researchPrefix = normalize(layout.researchDir) + "/";

  for (const relative of sourcePaths) {
    if (!(await pathExists(path.join(layout.vaultPath, relative)))) continue;
    const body = await readFile(path.join(layout.vaultPath, relative), "utf8");
    for (const rawTarget of extractWikilinkTargets(body)) {
      const target = rawTarget.split("|")[0]?.split("#")[0]?.trim();
      if (!target || !normalize(target).startsWith(researchPrefix)) continue;
      const briefPath = normalize(target).endsWith(".md")
        ? normalize(target)
        : normalize(target) + ".md";
      if (!isResearchPath(briefPath, layout)) {
        return `研究简报路径不合法: ${target}`;
      }
      if (!(await pathExists(path.join(layout.vaultPath, briefPath)))) {
        return `研究简报不存在: ${briefPath}`;
      }
    }
  }
  return undefined;
}

function extractWikilinkTargets(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1] ?? "");
}
