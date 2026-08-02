/**
 * 处理编排 CLI：VPS cron / 唤醒后执行。
 *
 *   VAULT_PATH=... npm run processor
 *
 * Agent 选择：
 * - AGENT_PROVIDER=codex → Codex CLI runner
 * - AGENT_PROVIDER=claude → Claude CLI runner
 * - ALLOW_NO_AGENT=1 → 只允许空收件箱探测
 */
import {
  loadAgentConfigFromEnv,
  loadProcessorOptionsFromEnv,
  loadResearchConfigFromEnv,
  loadRuntimeLogConfigFromEnv,
  loadVaultRuntimeConfigFromEnv,
} from "../env.js";
import { resolveVaultAccess } from "../git/real-git.js";
import { createFileLock } from "../runtime/lock.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import { createCodexAgentRunner } from "../agent/codex-runner.js";
import { createClaudeAgentRunner } from "../agent/claude-runner.js";
import { createCodexResearchRunner } from "../research/codex-runner.js";
import { logError, logInfo } from "../runtime/log.js";
import { cleanupRuntimeLogsAfterSuccess } from "../runtime/log-cleanup.js";
import type { AgentRunner, ResearchRunner } from "../types.js";

async function main(): Promise<void> {
  const options = loadProcessorOptionsFromEnv();
  const runtimeLogConfig = loadRuntimeLogConfigFromEnv();
  const runtime = loadVaultRuntimeConfigFromEnv();

  const access = resolveVaultAccess(
    options.layout.vaultPath,
    runtime.gitRemote,
    runtime.gitMode,
  );
  const lock = createFileLock(
    process.env.LOCK_PATH || "/run/koubo-processor.lock",
  );

  let agent: AgentRunner;
  let researchRunner: ResearchRunner | undefined;
  if (process.env.ALLOW_NO_AGENT === "1") {
    agent = {
      async run() {
        throw new Error(
          "ALLOW_NO_AGENT=1 仅用于探测锁/空收件箱；有待处理时请配置 AGENT_PROVIDER",
        );
      },
    };
  } else {
    const agentConfig = loadAgentConfigFromEnv();
    const researchConfig = loadResearchConfigFromEnv();
    agent =
      agentConfig.provider === "codex"
        ? createCodexAgentRunner(agentConfig)
        : createClaudeAgentRunner(agentConfig);
    researchRunner = createCodexResearchRunner(researchConfig);
  }

  const result = await runProcessorRound({
    options,
    workspace: access.workspace,
    ...(access.publisher ? { publisher: access.publisher } : {}),
    lock,
    agent,
    ...(researchRunner ? { researchRunner } : {}),
    clock: { now: () => new Date() },
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.status === "success" || result.status === "empty") {
    try {
      const cleaned = await cleanupRuntimeLogsAfterSuccess({
        ...runtimeLogConfig,
        enabled: runtimeLogConfig.cleanupOnSuccess,
      });
      if (cleaned) {
        logInfo("runtime.logs_cleaned", {
          directory: runtimeLogConfig.directory,
          scanned: cleaned.scanned,
          removed: cleaned.removed.length,
        });
      }
    } catch (error) {
      logError("runtime.logs_cleanup_failed", {
        directory: runtimeLogConfig.directory,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (result.status === "failed" || result.status === "conflict") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
