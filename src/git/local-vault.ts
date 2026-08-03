import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChangedPath, GitResult, VaultWorkspace } from "../types.js";

type FileSnapshot = Map<string, Buffer>;

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const names = await readdir(dir);

  const files: string[] = [];
  for (const name of names) {
    if (name === ".git") continue;
    const relative = base ? `${base}/${name}` : name;
    const absolute = path.join(dir, name);
    const entry = await stat(absolute);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute, relative)));
    } else {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files;
}

async function snapshotFiles(root: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  for (const relative of await walkFiles(root)) {
    snapshot.set(relative, await readFile(path.join(root, relative)));
  }
  return snapshot;
}

/**
 * 本地联调用的工作区 adapter：只记录文件快照，不调用 Git 命令、远端或提交。
 */
export function createLocalVaultWorkspace(root: string): VaultWorkspace {
  let baseline: FileSnapshot | undefined;

  async function ensureBaseline(): Promise<FileSnapshot> {
    if (!baseline) baseline = await snapshotFiles(root);
    return baseline;
  }

  return {
    async prepare(): Promise<GitResult> {
      baseline = await snapshotFiles(root);
      return { ok: true };
    },
    async listChanges(): Promise<ChangedPath[]> {
      const previous = await ensureBaseline();
      const current = await snapshotFiles(root);
      const changes: ChangedPath[] = [];
      const allPaths = new Set([...previous.keys(), ...current.keys()]);

      for (const relative of allPaths) {
        const before = previous.get(relative);
        const after = current.get(relative);
        if (!before && after) {
          changes.push({ path: relative, status: "A" });
        } else if (before && !after) {
          changes.push({ path: relative, status: "D" });
        } else if (before && after && !before.equals(after)) {
          changes.push({ path: relative, status: "M" });
        }
      }

      return changes;
    },
    async restore(relative: string): Promise<void> {
      const previous = await ensureBaseline();
      const content = previous.get(relative);
      const absolute = path.join(root, relative);
      if (content === undefined) {
        await rm(absolute, { force: true });
        return;
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    },
  };
}
