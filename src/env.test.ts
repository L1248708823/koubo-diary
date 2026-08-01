import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAgentConfigFromEnv,
  loadIngestConfigFromEnv,
  loadLayoutFromEnv,
  loadProcessorOptionsFromEnv,
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
});
