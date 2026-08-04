import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createTempVault, type TempVault } from "../testkit/temp-vault.js";
import { createVaultWorkspace, normalizeRemoteUrl } from "./real-git.js";

const execFileAsync = promisify(execFile);

describe("real git workspace", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("把 HTTPS 和 SSH 形式归一为同一个仓库地址", () => {
    expect(normalizeRemoteUrl("https://github.com/L1248708823/Obsidian.git"))
      .toBe("github.com/l1248708823/obsidian");
    expect(normalizeRemoteUrl("git@github.com:L1248708823/Obsidian.git"))
      .toBe("github.com/l1248708823/obsidian");
  });

  it("真实 Git 工作树 remote 匹配时通过预检，地址不匹配时拒绝", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    await execFileAsync("git", ["init"], { cwd: vault.root });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "git@github.com:L1248708823/Obsidian.git"],
      { cwd: vault.root },
    );

    const matching = createVaultWorkspace({
      vaultPath: vault.root,
      expectedRemoteUrl: "https://github.com/L1248708823/Obsidian",
    });
    await expect(matching.listChanges()).resolves.toEqual([]);

    const mismatched = createVaultWorkspace({
      vaultPath: vault.root,
      expectedRemoteUrl: "https://github.com/L1248708823/other-vault",
    });
    await expect(mismatched.listChanges()).rejects.toThrow("remote 不匹配");
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
