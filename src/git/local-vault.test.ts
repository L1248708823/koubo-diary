import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalVaultWorkspace } from "./local-vault.js";
import { createTempVault, writeDiary, type TempVault } from "../testkit/temp-vault.js";

describe("local vault ops", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("只做文件快照，不需要 Git remote", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const workspace = createLocalVaultWorkspace(vault.root);

    expect(await workspace.prepare()).toEqual({ ok: true });
    await writeDiary(vault.layout, "2026/2026-07/2026-07-30.md", "本地文件模式\n");

    expect(await workspace.listChanges()).toContainEqual({
      path: path.posix.join(
        vault.layout.diaryDir,
        "2026",
        "2026-07",
        "2026-07-30.md",
      ),
      status: "A",
    });
    await workspace.prepare();
    expect(await workspace.listChanges()).toEqual([]);
  });

  it("恢复空文件时保留文件，不把空内容当作缺失", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const workspace = createLocalVaultWorkspace(vault.root);
    const relative = `${vault.layout.stagingDir}/empty.md`;
    const absolute = path.join(vault.root, relative);

    await writeFile(absolute, "", "utf8");
    await workspace.prepare();
    await writeFile(absolute, "agent 修改\n", "utf8");

    await workspace.restore(relative);

    expect(await readFile(absolute, "utf8")).toBe("");
  });
});
