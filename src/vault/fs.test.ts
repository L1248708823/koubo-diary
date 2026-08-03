import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempVault, type TempVault } from "../testkit/temp-vault.js";
import { readInboxFrontmatterAttempts, readReceipt } from "./fs.js";

describe("vault inbox filesystem", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("attempts 读取错误时不返回默认的零", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const inboxRel = `${vault.layout.inboxDir}/broken.md`;
    await mkdir(path.join(vault.root, inboxRel));

    await expect(
      readInboxFrontmatterAttempts(vault.layout, inboxRel),
    ).rejects.toThrow();
  });

  it("回执解析错误时不返回缺失值", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    await writeFile(
      path.join(vault.root, vault.layout.processorDir, "last-run.json"),
      "{ malformed\n",
      "utf8",
    );

    await expect(readReceipt(vault.layout)).rejects.toThrow(/解析回执/i);
  });
});
