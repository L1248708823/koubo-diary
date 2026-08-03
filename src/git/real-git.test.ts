import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempVault, type TempVault } from "../testkit/temp-vault.js";
import { createVaultWorkspace } from "./real-git.js";

describe("real git workspace", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("Git status 失败时不返回空变更", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const workspace = createVaultWorkspace({ vaultPath: vault.root });

    await expect(workspace.listChanges()).rejects.toThrow(/git|repository|status/i);
  });

  it("Git 恢复前的查询失败时不删除目标文件", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const relative = "unexpected.md";
    const absolute = path.join(vault.root, relative);
    await writeFile(absolute, "必须保留\n", "utf8");
    const workspace = createVaultWorkspace({ vaultPath: vault.root });

    await expect(workspace.restore(relative)).rejects.toThrow(/git|repository/i);
    await expect(readFile(absolute, "utf8")).resolves.toBe("必须保留\n");
  });
});
