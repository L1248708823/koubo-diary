import type { ProcessorOptions, VaultLayout } from "./types.js";

export function defaultLayout(vaultPath: string): VaultLayout {
  return {
    vaultPath,
    inboxDir: "_inbox",
    quarantineDir: "_inbox/_quarantine",
    // 真实 vault 按日树前缀（ADR-0006）；其下为 YYYY/YYYY-MM/YYYY-MM-DD.md
    diaryDir: "生活/日子一天天过去",
    ideasDir: "想法",
    processorDir: "_processor",
    stagingDir: "_staging",
  };
}

export function defaultProcessorOptions(vaultPath: string): ProcessorOptions {
  return {
    layout: defaultLayout(vaultPath),
    maxPerRound: 10,
    maxAttempts: 3,
  };
}

export function whitelistPrefixes(layout: VaultLayout): string[] {
  return [
    normalizePrefix(layout.inboxDir),
    normalizePrefix(layout.stagingDir),
    normalizePrefix(layout.processorDir),
    normalizePrefix(layout.diaryDir),
    normalizePrefix(layout.ideasDir),
  ];
}

function normalizePrefix(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
}

export function isWhitelistedPath(path: string, layout: VaultLayout): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  // exact dir match (e.g. empty dir marker) or under prefix
  const prefixes = whitelistPrefixes(layout);
  for (const prefix of prefixes) {
    const bare = prefix.slice(0, -1);
    if (normalized === bare || normalized.startsWith(prefix)) return true;
  }
  return false;
}
