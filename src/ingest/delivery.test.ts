import { afterEach, describe, expect, it } from "vitest";
import { listPendingInbox } from "../vault/fs.js";
import { createTempVault, fixedClock, type TempVault } from "../testkit/temp-vault.js";
import type { VaultPublisher, VaultWorkspace } from "../types.js";
import {
  createLocalInboxDelivery,
  createRemoteInboxDelivery,
} from "./delivery.js";

describe("inbox delivery adapters", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      await vaults.pop()?.cleanup();
    }
  });

  it("local adapter 只写文件，不需要 workspace 或 publisher", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const delivery = createLocalInboxDelivery(vault.layout, fixedClock());

    const result = await delivery.deliver({
      text: "本地联调",
      capturedAt: "2026-07-29T12:00:00+08:00",
    });

    expect(result.ok).toBe(true);
    expect(await listPendingInbox(vault.layout)).toHaveLength(1);
  });

  it("remote adapter 只发布 VAULT_PATH 下的新 inbox 文件", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    let prepared = 0;
    let published: { paths: string[]; message: string } | undefined;
    const workspace: VaultWorkspace = {
      async prepare() {
        prepared += 1;
        return { ok: true };
      },
      async listChanges() {
        return [];
      },
      async restore() {},
    };
    const publisher: VaultPublisher = {
      async publish(paths, message) {
        published = { paths, message };
        return { ok: true };
      },
    };

    const result = await createRemoteInboxDelivery(
      vault.layout,
      fixedClock(),
      workspace,
      publisher,
    ).deliver({
      text: "生产投递",
      capturedAt: "2026-07-29T12:00:00+08:00",
    });

    expect(result.ok).toBe(true);
    expect(prepared).toBe(1);
    expect(published?.paths).toHaveLength(1);
    expect(published?.paths[0]).toMatch(/^_inbox\/20260729-120000-[a-z0-9]+\.md$/);
    expect(published?.message).toMatch(/^ingest: 20260729-120000-[a-z0-9]+$/);
  });

  it("remote commit 失败时清理未发布的 inbox 文件", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const workspace: VaultWorkspace = {
      async prepare() {
        return { ok: true };
      },
      async listChanges() {
        return [];
      },
      async restore() {},
    };
    const publisher: VaultPublisher = {
      async publish() {
        return { ok: false, reason: "commit failed", committed: false };
      },
    };

    const result = await createRemoteInboxDelivery(
      vault.layout,
      fixedClock(),
      workspace,
      publisher,
    ).deliver({
      text: "发布失败",
      capturedAt: "2026-07-29T12:00:00+08:00",
    });

    expect(result.ok).toBe(false);
    expect(await listPendingInbox(vault.layout)).toEqual([]);
  });
});
