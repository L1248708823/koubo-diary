import { mkdtemp, readdir, rm, stat, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultLayout, defaultProcessorOptions } from "../config.js";
import {
  ensureVaultDirs,
  writeInboxEntry,
  writeReceipt,
} from "../vault/fs.js";
import type {
  AgentRunner,
  ChangedPath,
  Clock,
  GitResult,
  Lock,
  LockHandle,
  ProcessorOptions,
  Receipt,
  VaultLayout,
  VaultPublisher,
  VaultWorkspace,
} from "../types.js";

export type TempVault = {
  root: string;
  layout: VaultLayout;
  options: ProcessorOptions;
  cleanup(): Promise<void>;
};

export async function createTempVault(prefix = "koubo-vault-"): Promise<TempVault> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const layout = defaultLayout(dir);
  await ensureVaultDirs(layout);
  return {
    root: dir,
    layout,
    options: defaultProcessorOptions(dir),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function seedInbox(
  layout: VaultLayout,
  text: string,
  opts?: { id?: string; attempts?: number; capturedAt?: string },
): Promise<string> {
  const id = opts?.id ?? "20260729-120000-test01";
  return writeInboxEntry(layout, {
    id,
    text,
    capturedAt: opts?.capturedAt ?? "2026-07-29T12:00:00+08:00",
    attempts: opts?.attempts ?? 0,
    filename: `${id}.md`,
  });
}

export function fixedClock(iso = "2026-07-29T12:00:00+08:00"): Clock {
  return { now: () => new Date(iso) };
}

export function createMemoryLock(
  held = false,
): Lock & { forceHold(v: boolean): void; isHeld(): boolean } {
  let isHeld = held;
  return {
    forceHold(v: boolean) {
      isHeld = v;
    },
    isHeld() {
      return isHeld;
    },
    async tryAcquire(): Promise<LockHandle | null> {
      if (isHeld) return null;
      isHeld = true;
      return {
        async release() {
          isHeld = false;
        },
      };
    },
  };
}

export type FakeVaultControls = {
  pullResult: GitResult;
  pushResult: GitResult;
  commitResult: GitResult;
  head: string;
  extraChanges: ChangedPath[];
  /** Paths whose content we keep for workspace.restore. */
  headFiles: Map<string, string>;
  baseline: Set<string>;
};

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name === ".git") continue;
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) {
      out.push(...(await walkFiles(full, rel)));
    } else {
      out.push(rel.replace(/\\/g, "/"));
    }
  }
  return out;
}

export async function createFakeVaultAccess(layout: VaultLayout): Promise<{
  workspace: VaultWorkspace;
  publisher: VaultPublisher;
  controls: FakeVaultControls;
  snapshotBaseline(): Promise<void>;
  captureHead(): Promise<void>;
}> {
  const controls: FakeVaultControls = {
    pullResult: { ok: true },
    pushResult: { ok: true },
    commitResult: { ok: true },
    head: "HEAD-TEST",
    extraChanges: [],
    headFiles: new Map(),
    baseline: new Set(),
  };

  async function snapshotBaseline(): Promise<void> {
    controls.baseline = new Set(await walkFiles(layout.vaultPath));
  }

  async function captureHead(): Promise<void> {
    const files = await walkFiles(layout.vaultPath);
    controls.headFiles = new Map();
    for (const rel of files) {
      const content = await readFile(path.join(layout.vaultPath, rel), "utf8");
      controls.headFiles.set(rel, content);
    }
    await snapshotBaseline();
  }

  await captureHead();

  const workspace: VaultWorkspace = {
    async prepare() {
      return controls.pullResult;
    },
    async listChanges() {
      const now = await walkFiles(layout.vaultPath);
      const nowSet = new Set(now);
      const changes: ChangedPath[] = [];
      const seen = new Set<string>();

      for (const p of nowSet) {
        if (!controls.baseline.has(p)) {
          changes.push({ path: p, status: "A" });
          seen.add(p);
        }
      }
      for (const p of controls.baseline) {
        if (!nowSet.has(p)) {
          changes.push({ path: p, status: "D" });
          seen.add(p);
        }
      }
      for (const p of nowSet) {
        if (seen.has(p)) continue;
        if (!controls.baseline.has(p)) continue;
        const interesting =
          p.startsWith(layout.diaryDir + "/") ||
          p === layout.diaryDir ||
          p.startsWith(layout.ideasDir + "/") ||
          p === layout.ideasDir ||
          p.startsWith(layout.researchDir + "/") ||
          p === layout.researchDir ||
          p.startsWith(layout.processorDir + "/") ||
          p === layout.processorDir ||
          p.startsWith(layout.stagingDir + "/") ||
          p === layout.stagingDir ||
          p.startsWith(layout.inboxDir + "/") ||
          p === layout.inboxDir;
        if (interesting) {
          // Compare content to head snapshot when available
          const prev = controls.headFiles.get(p);
          if (prev !== undefined) {
            const cur = await readFile(path.join(layout.vaultPath, p), "utf8");
            if (cur !== prev) {
              changes.push({ path: p, status: "M" });
            }
          } else {
            changes.push({ path: p, status: "M" });
          }
        }
      }
      return [...changes, ...controls.extraChanges];
    },
    async restore(relPath: string) {
      const content = controls.headFiles.get(relPath);
      const abs = path.join(layout.vaultPath, relPath);
      if (content === undefined) {
        await rm(abs, { force: true });
        return;
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    },
  };

  const publisher: VaultPublisher = {
    async publish(_paths, _message) {
      if (!controls.commitResult.ok) return controls.commitResult;
      controls.head = `${controls.head}-c`;
      await captureHead();
      return controls.pushResult;
    },
  };

  return { workspace, publisher, controls, snapshotBaseline, captureHead };
}

export function createFakeAgent(
  mutator: (ctx: {
    layout: VaultLayout;
    pendingInbox: string[];
    roundId: string;
  }) => Promise<Omit<Receipt, "round_id"> & { round_id?: string }>,
): AgentRunner {
  return {
    async run(ctx) {
      const receipt = await mutator({
        layout: ctx.layout,
        pendingInbox: ctx.pendingInbox,
        roundId: ctx.roundId,
      });
      await writeReceipt(ctx.layout, {
        ...receipt,
        round_id: receipt.round_id ?? ctx.roundId,
      });
    },
  };
}

export async function writeDiary(
  layout: VaultLayout,
  dateFile: string,
  body: string,
): Promise<string> {
  const rel = `${layout.diaryDir}/${dateFile}`.replace(/\\/g, "/");
  await mkdir(path.dirname(path.join(layout.vaultPath, rel)), { recursive: true });
  await writeFile(path.join(layout.vaultPath, rel), body, "utf8");
  return rel;
}

export async function writeIdea(
  layout: VaultLayout,
  name: string,
  body: string,
): Promise<string> {
  const rel = `${layout.ideasDir}/${name}`.replace(/\\/g, "/");
  await mkdir(path.join(layout.vaultPath, layout.ideasDir), { recursive: true });
  await writeFile(path.join(layout.vaultPath, rel), body, "utf8");
  return rel;
}
