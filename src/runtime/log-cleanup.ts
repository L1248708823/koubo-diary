import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export type RuntimeLogCleanupOptions = {
  directory: string;
  retentionMs: number;
  now?: Date;
};

export type RuntimeLogCleanupResult = {
  scanned: number;
  removed: string[];
  retained: string[];
};

export type RuntimeLogCleanupConfig = {
  directory?: string;
  enabled: boolean;
  retentionMs: number;
  now?: Date;
};

export async function cleanupRuntimeLogsAfterSuccess(
  config: RuntimeLogCleanupConfig,
): Promise<RuntimeLogCleanupResult | undefined> {
  if (!config.enabled || !config.directory) return undefined;
  return cleanupRuntimeLogs({
    directory: config.directory,
    retentionMs: config.retentionMs,
    ...(config.now ? { now: config.now } : {}),
  });
}

export async function cleanupRuntimeLogs(
  options: RuntimeLogCleanupOptions,
): Promise<RuntimeLogCleanupResult> {
  if (!Number.isFinite(options.retentionMs) || options.retentionMs < 0) {
    throw new Error("日志保留期限必须是非负有限数字");
  }

  let entries;
  try {
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) {
      return { scanned: 0, removed: [], retained: [] };
    }
    throw error;
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const removed: string[] = [];
  const retained: string[] = [];
  let scanned = 0;

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) {
      continue;
    }

    scanned += 1;
    const relative = entry.name;
    const absolute = path.join(options.directory, relative);
    const metadata = await stat(absolute);
    const ageMs = nowMs - metadata.mtimeMs;
    if (ageMs < options.retentionMs) {
      retained.push(relative);
      continue;
    }

    try {
      await rm(absolute, { force: true });
      removed.push(relative);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }

  return { scanned, removed, retained };
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
