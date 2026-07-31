import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { acceptRound } from "./accept.js";
import { createTempVault, seedInbox, type TempVault } from "../testkit/temp-vault.js";
import { writeReceipt } from "../vault/fs.js";

describe("processor acceptance", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("拒绝回执声明日记树内的想法路径", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "测试嵌套想法路径");
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const nestedIdea = `${vault.layout.diaryDir}/2026/2026-07/想法/嵌套.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, nestedIdea)), { recursive: true });
    await writeFile(path.join(vault.root, nestedIdea), "# 错误路径\n", "utf8");
    await writeReceipt(vault.layout, {
      ok: true,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [
        {
          inbox,
          status: "done",
          diary,
          idea: nestedIdea,
        },
      ],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [{ path: diary, status: "A" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("idea 路径");
    }
  });
});
