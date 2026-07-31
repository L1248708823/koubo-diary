import path from "node:path";
import { defaultLayout } from "./config.js";
import type { ProcessorOptions, VaultGitMode, VaultLayout } from "./types.js";

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
    researchDir: env("RESEARCH_DIR", base.researchDir)!,
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

export function loadVaultRuntimeConfigFromEnv(): {
  gitRemote: string;
  gitMode: VaultGitMode;
} {
  const gitMode = env("VAULT_GIT_MODE", "remote");
  if (gitMode !== "remote" && gitMode !== "local") {
    throw new Error("VAULT_GIT_MODE 只支持 remote 或 local");
  }
  return {
    gitRemote: env("GIT_REMOTE", "origin")!,
    gitMode,
  };
}

export function loadIngestConfigFromEnv() {
  const token = env("INGEST_TOKEN");
  if (!token) throw new Error("缺少环境变量 INGEST_TOKEN");
  const runtime = loadVaultRuntimeConfigFromEnv();
  return {
    token,
    host: env("INGEST_HOST", "127.0.0.1")!,
    port: envInt("INGEST_PORT", 8787),
    path: env("INGEST_PATH", "/ingest")!,
    corsOrigin: env("INGEST_CORS_ORIGIN"),
    wakeMode: env("WAKE_MODE", "file") as "file" | "callback" | "none",
    wakeFlagPath: env("WAKE_FLAG_PATH", "/run/koubo-processor.wake")!,
    lockPath: env("LOCK_PATH", "/run/koubo-processor.lock")!,
    ...runtime,
  };
}

export type AgentProvider = "codex" | "claude";

export type AgentConfig = {
  provider: AgentProvider;
  bin: string;
  skill: string;
};

export function loadAgentConfigFromEnv(): AgentConfig {
  const provider = env("AGENT_PROVIDER");
  if (provider !== "codex" && provider !== "claude") {
    throw new Error(
      "缺少或不支持 AGENT_PROVIDER。请明确设置为 codex 或 claude",
    );
  }

  const configuredBin = env(provider === "codex" ? "CODEX_BIN" : "CLAUDE_BIN");
  const defaultBin =
    process.platform === "win32"
      ? provider === "codex"
        ? "codex.cmd"
        : "claude.cmd"
      : provider;

  return {
    provider,
    bin: configuredBin ?? defaultBin,
    skill: env("PROCESSOR_SKILL", "处理收件箱")!,
  };
}
