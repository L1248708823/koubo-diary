/**
 * 处理编排 CLI：VPS cron / 唤醒后执行。
 *
 *   VAULT_PATH=... npm run processor
 *
 * Agent 选择：
 * - 设了 CLAUDE_BIN 或 ANTHROPIC_API_KEY → 真 Claude runner
 * - 否则报错（生产必须真 agent）；测试请直接调 runProcessorRound + fake agent
 */
import { loadProcessorOptionsFromEnv, loadIngestConfigFromEnv } from "../env.js";
import { resolveVaultGit } from "../git/real-git.js";
import { createFileLock } from "../runtime/lock.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import { createClaudeAgentRunner } from "../agent/claude-runner.js";
import type { AgentRunner } from "../types.js";

async function main(): Promise<void> {
  const options = loadProcessorOptionsFromEnv();
  const ingestCfg = (() => {
    try {
      return loadIngestConfigFromEnv();
    } catch {
      return {
        lockPath: process.env.LOCK_PATH || "/run/koubo-processor.lock",
        gitRemote: process.env.GIT_REMOTE || "origin",
      };
    }
  })();

  const git = resolveVaultGit(options.layout.vaultPath, ingestCfg.gitRemote);
  const lock = createFileLock(
    "lockPath" in ingestCfg
      ? ingestCfg.lockPath
      : process.env.LOCK_PATH || "/run/koubo-processor.lock",
  );

  let agent: AgentRunner;
  if (process.env.CLAUDE_BIN || process.env.ANTHROPIC_API_KEY) {
    agent = createClaudeAgentRunner();
  } else if (process.env.ALLOW_NO_AGENT === "1") {
    agent = {
      async run() {
        throw new Error(
          "ALLOW_NO_AGENT=1 仅用于探测锁/空收件箱；有待处理时请配置 Claude",
        );
      },
    };
  } else {
    throw new Error(
      "未配置 CLAUDE_BIN / ANTHROPIC_API_KEY。密钥到位前请用测试套件中的假 agent；或空跑探测设 ALLOW_NO_AGENT=1",
    );
  }

  const result = await runProcessorRound({
    options,
    git,
    lock,
    agent,
    clock: { now: () => new Date() },
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed" || result.status === "conflict") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
