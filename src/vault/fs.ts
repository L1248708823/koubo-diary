import { mkdir, readdir, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import path from "node:path";
import type { Receipt, VaultLayout } from "../types.js";

export async function ensureVaultDirs(layout: VaultLayout): Promise<void> {
  const roots = [
    layout.inboxDir,
    layout.quarantineDir,
    layout.diaryDir,
    layout.ideasDir,
    layout.researchDir,
    layout.processorDir,
    layout.stagingDir,
  ];
  for (const dir of roots) {
    await mkdir(path.join(layout.vaultPath, dir), { recursive: true });
  }
}

export function inboxAbs(layout: VaultLayout, relOrName: string): string {
  const normalized = relOrName.replace(/\\/g, "/");
  if (normalized.startsWith(layout.inboxDir + "/") || normalized === layout.inboxDir) {
    return path.join(layout.vaultPath, normalized);
  }
  return path.join(layout.vaultPath, layout.inboxDir, normalized);
}

export function vaultRel(layout: VaultLayout, absPath: string): string {
  return path.relative(layout.vaultPath, absPath).replace(/\\/g, "/");
}

export async function listPendingInbox(layout: VaultLayout): Promise<string[]> {
  const inboxPath = path.join(layout.vaultPath, layout.inboxDir);
  let entries: string[];
  try {
    entries = await readdir(inboxPath);
  } catch {
    return [];
  }
  const pending: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "_quarantine") continue;
    const full = path.join(inboxPath, name);
    // only top-level files
    try {
      const { stat } = await import("node:fs/promises");
      const st = await stat(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (!name.endsWith(".md")) continue;
    pending.push(`${layout.inboxDir}/${name}`.replace(/\\/g, "/"));
  }
  pending.sort();
  return pending;
}

export async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function readReceipt(layout: VaultLayout): Promise<unknown | null> {
  const p = path.join(layout.vaultPath, layout.processorDir, "last-run.json");
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function writeReceipt(layout: VaultLayout, receipt: Receipt): Promise<void> {
  const dir = path.join(layout.vaultPath, layout.processorDir);
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, "last-run.json");
  await writeFile(p, JSON.stringify(receipt, null, 2) + "\n", "utf8");
}

export async function writeState(layout: VaultLayout, body: string): Promise<void> {
  const dir = path.join(layout.vaultPath, layout.processorDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "STATE.md"), body, "utf8");
}

export async function readInboxFrontmatterAttempts(
  layout: VaultLayout,
  inboxRel: string,
): Promise<number> {
  const abs = path.join(layout.vaultPath, inboxRel);
  try {
    const raw = await readFile(abs, "utf8");
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return 0;
    const attemptsLine = match[1]?.match(/^attempts:\s*(\d+)\s*$/m);
    if (!attemptsLine) return 0;
    return Number(attemptsLine[1]);
  } catch {
    return 0;
  }
}

export async function bumpInboxAttempts(
  layout: VaultLayout,
  inboxRel: string,
): Promise<number> {
  const abs = path.join(layout.vaultPath, inboxRel);
  const raw = await readFile(abs, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
  if (!match) {
    const next = 1;
    const wrapped = `---\nattempts: ${next}\n---\n\n${raw}`;
    await writeFile(abs, wrapped, "utf8");
    return next;
  }
  const fm = match[1] ?? "";
  const rest = raw.slice(match[0].length);
  let next = 1;
  let newFm: string;
  if (/^attempts:\s*\d+\s*$/m.test(fm)) {
    newFm = fm.replace(/^attempts:\s*\d+\s*$/m, (line) => {
      const n = Number(line.replace(/\D/g, "")) + 1;
      next = n;
      return `attempts: ${n}`;
    });
  } else {
    newFm = fm + (fm.endsWith("\n") ? "" : "\n") + `attempts: ${next}\n`;
  }
  await writeFile(abs, `---\n${newFm.replace(/\n*$/, "\n")}---\n${rest}`, "utf8");
  return next;
}

export async function moveToQuarantine(
  layout: VaultLayout,
  inboxRel: string,
): Promise<string> {
  const abs = path.join(layout.vaultPath, inboxRel);
  const base = path.basename(inboxRel);
  const destDir = path.join(layout.vaultPath, layout.quarantineDir);
  await mkdir(destDir, { recursive: true });
  const destAbs = path.join(destDir, base);
  await rename(abs, destAbs);
  return `${layout.quarantineDir}/${base}`.replace(/\\/g, "/");
}

export async function deleteInboxFile(layout: VaultLayout, inboxRel: string): Promise<void> {
  const abs = path.join(layout.vaultPath, inboxRel);
  await rm(abs, { force: true });
}

export async function writeInboxEntry(
  layout: VaultLayout,
  opts: {
    id: string;
    text: string;
    capturedAt: string;
    source?: string;
    attempts?: number;
    filename?: string;
  },
): Promise<string> {
  await mkdir(path.join(layout.vaultPath, layout.inboxDir), { recursive: true });
  const filename = opts.filename ?? `${opts.id}.md`;
  const rel = `${layout.inboxDir}/${filename}`.replace(/\\/g, "/");
  const body = [
    "---",
    `id: ${opts.id}`,
    `captured_at: ${opts.capturedAt}`,
    `source: ${opts.source ?? "capture-pwa"}`,
    `attempts: ${opts.attempts ?? 0}`,
    "---",
    "",
    opts.text,
    "",
  ].join("\n");
  await writeFile(path.join(layout.vaultPath, rel), body, "utf8");
  return rel;
}

export function shortId(length = 6): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Build inbox id + filename: YYYYMMDD-HHMMSS-<shortid> */
export function makeInboxId(now: Date, ident?: string): { id: string; filename: string } {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const tail = ident ?? shortId();
  const id = `${stamp}-${tail}`;
  return { id, filename: `${id}.md` };
}
