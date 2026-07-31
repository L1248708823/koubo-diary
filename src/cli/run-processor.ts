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
  loadVaultRuntimeConfigFromEnv,
} from "../env.js";
import { resolveVaultAccess } from "../git/real-git.js";
import { createFileLock } from "../runtime/lock.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import { createCodexAgentRunner } from "../agent/codex-runner.js";
import { createClaudeAgentRunner } from "../agent/claude-runner.js";
import type { AgentRunner } from "../types.js";

async function main(): Promise<void> {
  const options = loadProcessorOptionsFromEnv();
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
    agent =
      agentConfig.provider === "codex"
        ? createCodexAgentRunner(agentConfig)
        : createClaudeAgentRunner(agentConfig);
  }

  const result = await runProcessorRound({
    options,
    workspace: access.workspace,
    ...(access.publisher ? { publisher: access.publisher } : {}),
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
