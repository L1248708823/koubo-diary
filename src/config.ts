import type { ProcessorOptions, VaultLayout } from "./types.js";

export function defaultLayout(vaultPath: string): VaultLayout {
  return {
    vaultPath,
    inboxDir: "_inbox",
    quarantineDir: "_inbox/_quarantine",
    // 真实 vault 按日树前缀（ADR-0006）；其下为 YYYY/YYYY-MM/YYYY-MM-DD.md
    diaryDir: "生活/日子一天天过去",
    ideasDir: "Yan帳/想法",
    researchDir: "Yan帳/研究",
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
    normalizePrefix(layout.researchDir),
  ];
}

function normalizePrefix(dir: string): string {
  return `${normalizeDir(dir)}/`;
}

export function isIdeaPath(path: string, layout: VaultLayout): boolean {
  return isFlatMarkdownPath(path, layout.ideasDir);
}

export function isResearchPath(path: string, layout: VaultLayout): boolean {
  return isFlatMarkdownPath(path, layout.researchDir);
}

export function isDiaryPath(path: string, layout: VaultLayout): boolean {
  const normalized = normalizeRelativePath(path);
  if (!isSafeRelativePath(normalized)) return false;

  const diaryRoot = normalizeDir(layout.diaryDir);
  const relative = normalized.slice(`${diaryRoot}/`.length);
  return (
    normalized.startsWith(`${diaryRoot}/`) &&
    /^\d{4}\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\.md$/.test(relative) &&
    !isNestedIdeaPathInDiary(normalized, layout)
  );
}

export function isWhitelistedPath(path: string, layout: VaultLayout): boolean {
  const normalized = normalizeRelativePath(path);
  if (!isSafeRelativePath(normalized)) return false;

  // 想法目录是顶层扁平目录；日记树下同名子目录不属于合法写回位置。
  if (isNestedIdeaPathInDiary(normalized, layout)) return false;

  // exact dir match (e.g. empty dir marker) or under prefix
  const prefixes = whitelistPrefixes(layout);
  for (const prefix of prefixes) {
    const bare = prefix.slice(0, -1);
    if (normalized === bare) {
      return (
        bare !== normalizeDir(layout.ideasDir) &&
        bare !== normalizeDir(layout.researchDir)
      );
    }
    if (!normalized.startsWith(prefix)) continue;
    if (bare === normalizeDir(layout.ideasDir)) {
      return isIdeaPath(normalized, layout);
    }
    if (bare === normalizeDir(layout.researchDir)) {
      return isResearchPath(normalized, layout);
    }
    return true;
  }
  return false;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function normalizeDir(value: string): string {
  return normalizeRelativePath(value).replace(/\/+$/, "");
}

function isFlatMarkdownPath(path: string, root: string): boolean {
  const normalized = normalizeRelativePath(path);
  if (!isSafeRelativePath(normalized)) return false;

  const prefix = `${normalizeDir(root)}/`;
  if (!normalized.startsWith(prefix)) return false;

  const filename = normalized.slice(prefix.length);
  return filename.length > 0 && !filename.includes("/") && filename.endsWith(".md");
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  return !value
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function isNestedIdeaPathInDiary(value: string, layout: VaultLayout): boolean {
  const diaryPrefix = `${normalizeDir(layout.diaryDir)}/`;
  if (!value.startsWith(diaryPrefix)) return false;

  const diarySegments = value.slice(diaryPrefix.length).split("/");
  const ideaSegments = normalizeDir(layout.ideasDir).split("/");
  return diarySegments.some((_, index) =>
    ideaSegments.every((segment, offset) => diarySegments[index + offset] === segment),
  );
}
