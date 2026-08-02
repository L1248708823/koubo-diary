import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  loadAgentConfigFromEnv,
  loadIngestConfigFromEnv,
  loadLayoutFromEnv,
  loadProcessorOptionsFromEnv,
  loadResearchConfigFromEnv,
  loadRuntimeLogConfigFromEnv,
} from "./env.js";

describe("agent provider config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("明确选择 Codex 并读取 CODEX_BIN", () => {
    vi.stubEnv("AGENT_PROVIDER", "codex");
    vi.stubEnv("CODEX_BIN", "custom-codex");

    expect(loadAgentConfigFromEnv()).toEqual({
      provider: "codex",
      bin: "custom-codex",
      skill: "处理收件箱",
    });
  });

  it("明确选择 Claude 并读取 CLAUDE_BIN", () => {
    vi.stubEnv("AGENT_PROVIDER", "claude");
    vi.stubEnv("CLAUDE_BIN", "custom-claude");

    expect(loadAgentConfigFromEnv()).toEqual({
      provider: "claude",
      bin: "custom-claude",
      skill: "处理收件箱",
    });
  });

  it("没有明确 provider 时拒绝启动", () => {
    vi.stubEnv("AGENT_PROVIDER", "");

    expect(() => loadAgentConfigFromEnv()).toThrow(
      "AGENT_PROVIDER",
    );
  });

  it("本地模式明确跳过 vault Git 生命周期", () => {
    vi.stubEnv("INGEST_TOKEN", "local-token");
    vi.stubEnv("VAULT_GIT_MODE", "local");

    expect(loadIngestConfigFromEnv().gitMode).toBe("local");
  });

  it("不接受未知 vault Git 模式", () => {
    vi.stubEnv("INGEST_TOKEN", "local-token");
    vi.stubEnv("VAULT_GIT_MODE", "other");

    expect(() => loadIngestConfigFromEnv()).toThrow("VAULT_GIT_MODE");
  });

  it("读取 Yan帳 想法与研究目录配置", () => {
    vi.stubEnv("VAULT_PATH", "D:/vault");
    vi.stubEnv("IDEAS_DIR", "Yan帳/想法");
    vi.stubEnv("RESEARCH_DIR", "Yan帳/研究");

    expect(loadLayoutFromEnv()).toMatchObject({
      ideasDir: "Yan帳/想法",
      researchDir: "Yan帳/研究",
    });
  });

  it("读取独立的研究任务单轮上限", () => {
    vi.stubEnv("VAULT_PATH", "D:/vault");
    vi.stubEnv("MAX_PER_ROUND", "10");
    vi.stubEnv("MAX_RESEARCH_PER_ROUND", "2");

    expect(loadProcessorOptionsFromEnv().maxResearchPerRound).toBe(2);
  });

  it("读取研究 runner 的 CLI、模型、思考能力和超时配置", () => {
    vi.stubEnv("CODEX_BIN", "codex-from-agent");
    vi.stubEnv("RESEARCH_BIN", "codex-research");
    vi.stubEnv("RESEARCH_SKILL", "research-brief");
    vi.stubEnv("RESEARCH_MODEL", "gpt-5.6-luna");
    vi.stubEnv("RESEARCH_REASONING_EFFORT", "max");
    vi.stubEnv("RESEARCH_TIMEOUT_MS", "123456");

    expect(loadResearchConfigFromEnv()).toEqual({
      bin: "codex-research",
      skill: "research-brief",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      timeoutMs: 123456,
    });
  });

  it("读取本地日志清理目录、开关和保留期限", () => {
    vi.stubEnv("RUNTIME_LOG_DIR", "temp/runtime-logs");
    vi.stubEnv("LOG_CLEANUP_ON_SUCCESS", "1");
    vi.stubEnv("LOG_RETENTION_MS", "900000");

    expect(loadRuntimeLogConfigFromEnv()).toEqual({
      directory: path.resolve("temp/runtime-logs"),
      cleanupOnSuccess: true,
      retentionMs: 900000,
    });
  });
});
