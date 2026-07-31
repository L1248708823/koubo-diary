import { rm } from "node:fs/promises";
import path from "node:path";
import type {
  Clock,
  VaultLayout,
  VaultPublisher,
  VaultWorkspace,
} from "../types.js";
import { makeInboxId, writeInboxEntry } from "../vault/fs.js";

export type InboxDeliveryInput = {
  text: string;
  capturedAt: string;
};

export type InboxDeliveryResult =
  | { ok: true; id: string }
  | { ok: false; reason: string; conflict?: boolean };

export type InboxDelivery = {
  deliver(input: InboxDeliveryInput): Promise<InboxDeliveryResult>;
};

/** 本地联调 adapter：只写 vault 文件，不拥有任何 Git 发布能力。 */
export function createLocalInboxDelivery(
  layout: VaultLayout,
  clock: Clock,
): InboxDelivery {
  return {
    async deliver(input): Promise<InboxDeliveryResult> {
      const { id, filename } = makeInboxId(clock.now());
      await writeInboxEntry(layout, {
        id,
        text: input.text,
        capturedAt: input.capturedAt,
        source: "capture-pwa",
        attempts: 0,
        filename,
      });
      return { ok: true, id };
    },
  };
}

/** 生产 adapter：只对 VAULT_PATH 下的日记仓执行 Git 生命周期。 */
export function createRemoteInboxDelivery(
  layout: VaultLayout,
  clock: Clock,
  workspace: VaultWorkspace,
  publisher: VaultPublisher,
): InboxDelivery {
  return {
    async deliver(input): Promise<InboxDeliveryResult> {
      const prepared = await workspace.prepare();
      if (!prepared.ok) {
        return {
          ok: false,
          reason: prepared.reason ?? "vault pull 失败",
          ...(prepared.conflict ? { conflict: true } : {}),
        };
      }

      const { id, filename } = makeInboxId(clock.now());
      const rel = await writeInboxEntry(layout, {
        id,
        text: input.text,
        capturedAt: input.capturedAt,
        source: "capture-pwa",
        attempts: 0,
        filename,
      });

      const published = await publisher.publish([rel], `ingest: ${id}`);
      if (!published.ok) {
        if (published.committed === false) {
          await cleanupInbox(layout, rel);
        }
        return {
          ok: false,
          reason: published.reason ?? "vault publish 失败",
          ...(published.conflict ? { conflict: true } : {}),
        };
      }

      return { ok: true, id };
    },
  };
}

async function cleanupInbox(layout: VaultLayout, relativePath: string): Promise<void> {
  try {
    await rm(path.join(layout.vaultPath, relativePath), { force: true });
  } catch {
    /* best effort：避免提交失败时遗留半成品 */
  }
}
