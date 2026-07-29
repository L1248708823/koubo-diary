import path from "node:path";
import { defaultLayout } from "./config.js";
import type { ProcessorOptions, VaultLayout } from "./types.js";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadLayoutFromEnv(): VaultLayout {
  const vaultPath = env("VAULT_PATH");
  if (!vaultPath) {
    throw new Error("缺少环境变量 VAULT_PATH");
  }
  const base = defaultLayout(path.resolve(vaultPath));
  return {
    vaultPath: base.vaultPath,
    inboxDir: env("INBOX_DIR", base.inboxDir)!,
    quarantineDir: env(
      "QUARANTINE_DIR",
      path.posix.join(env("INBOX_DIR", base.inboxDir)!, "_quarantine"),
    )!,
    diaryDir: env("DIARY_DIR", base.diaryDir)!,
    ideasDir: env("IDEAS_DIR", base.ideasDir)!,
    processorDir: env("PROCESSOR_DIR", base.processorDir)!,
    stagingDir: env("STAGING_DIR", base.stagingDir)!,
  };
}

export function loadProcessorOptionsFromEnv(): ProcessorOptions {
  return {
    layout: loadLayoutFromEnv(),
    maxPerRound: envInt("MAX_PER_ROUND", 10),
    maxAttempts: envInt("MAX_ATTEMPTS", 3),
  };
}

export function loadIngestConfigFromEnv() {
  const token = env("INGEST_TOKEN");
  if (!token) throw new Error("缺少环境变量 INGEST_TOKEN");
  return {
    token,
    host: env("INGEST_HOST", "127.0.0.1")!,
    port: envInt("INGEST_PORT", 8787),
    path: env("INGEST_PATH", "/ingest")!,
    wakeMode: env("WAKE_MODE", "file") as "file" | "callback" | "none",
    wakeFlagPath: env("WAKE_FLAG_PATH", "/run/koubo-processor.wake")!,
    lockPath: env("LOCK_PATH", "/run/koubo-processor.lock")!,
    gitRemote: env("GIT_REMOTE", "origin")!,
  };
}

export function loadAgentModeFromEnv(): "fake-required" | "claude" {
  if (env("CLAUDE_BIN") || env("ANTHROPIC_API_KEY")) return "claude";
  return "fake-required";
}
