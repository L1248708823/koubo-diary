/**
 * 收件 HTTP CLI。
 *
 *   INGEST_TOKEN=... VAULT_PATH=... npm run ingest
 *
 * 投递成功后默认写 WAKE_FLAG_PATH；可用 WAKE_MODE=none 关闭。
 * 同机编排可用旁路 watch flag，或 systemctl --no-block。
 * VAULT_GIT_MODE=local 时，投递成功后由本进程排队跑一轮 processor。
 */
import {
  loadAgentConfigFromEnv,
  loadIngestConfigFromEnv,
  loadLayoutFromEnv,
  loadProcessorOptionsFromEnv,
} from "../env.js";
import { resolveVaultAccess } from "../git/real-git.js";
import { createClaudeAgentRunner } from "../agent/claude-runner.js";
import { createCodexAgentRunner } from "../agent/codex-runner.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import { createMergedProcessorQueue } from "../processor/queue.js";
import { createFileLock, touchWakeFlag } from "../runtime/lock.js";
import type { AgentRunner } from "../types.js";
import { createIngestServer } from "../ingest/server.js";
import {
  createLocalInboxDelivery,
  createRemoteInboxDelivery,
} from "../ingest/delivery.js";
import {
  countPendingResearchTasks,
  countRunnableResearchTasks,
} from "../research/tasks.js";
import { ensureVaultDirs, listPendingInbox } from "../vault/fs.js";
import { logError, logInfo } from "../runtime/log.js";

async function main(): Promise<void> {
  const layout = loadLayoutFromEnv();
  const cfg = loadIngestConfigFromEnv();
  await ensureVaultDirs(layout);
  const clock = { now: () => new Date() };
  const access = resolveVaultAccess(layout.vaultPath, cfg.gitRemote, cfg.gitMode);
  const delivery = access.publisher
    ? createRemoteInboxDelivery(
        layout,
        clock,
        access.workspace,
        access.publisher,
      )
    : createLocalInboxDelivery(layout, clock);

  let localProcessorQueue:
    | ReturnType<typeof createMergedProcessorQueue>
    | undefined;
  if (cfg.gitMode === "local") {
    const processorOptions = loadProcessorOptionsFromEnv();
    const agentConfig = loadAgentConfigFromEnv();
    const agent: AgentRunner =
      agentConfig.provider === "codex"
        ? createCodexAgentRunner(agentConfig)
        : createClaudeAgentRunner(agentConfig);
    const lock = createFileLock(cfg.lockPath);

    const runLocalProcessor = async (retryResearch = false) => {
      const result = await runProcessorRound({
        options: processorOptions,
        workspace: access.workspace,
        ...(access.publisher ? { publisher: access.publisher } : {}),
        lock,
        agent,
        retryFailedResearch: retryResearch,
        clock,
      });
      console.log(JSON.stringify({ localProcessor: result }, null, 2));
      return {
        status: result.status,
        progressed: result.progressed,
      };
    };

    localProcessorQueue = createMergedProcessorQueue({
      label: "local-ingest",
      run: runLocalProcessor,
      hasWork: async (includeRetryableResearch = false) => {
        const inboxPending = (await listPendingInbox(layout)).length > 0;
        let researchPending = false;
        try {
          researchPending =
            (await (includeRetryableResearch
              ? countRunnableResearchTasks(layout)
              : countPendingResearchTasks(layout))) > 0;
        } catch (error) {
          logError("processor.queue_work_scan_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return inboxPending || researchPending;
      },
    });
  }

  const server = await createIngestServer({
    token: cfg.token,
    delivery,
    clock,
    host: cfg.host,
    port: cfg.port,
    path: cfg.path,
    ...(cfg.corsOrigin ? { corsOrigin: cfg.corsOrigin } : {}),
    onWake: async () => {
      if (cfg.gitMode === "local") {
        localProcessorQueue?.enqueue();
        return;
      }
      if (cfg.wakeMode === "none") return;
      if (cfg.wakeMode === "file") {
        await touchWakeFlag(cfg.wakeFlagPath);
        return;
      }
      // callback 模式留给同进程嵌入；CLI 默认 file
      await touchWakeFlag(cfg.wakeFlagPath);
    },
  });

  logInfo("ingest.server_started", {
    host: server.host,
    port: server.port,
    path: cfg.path,
    vaultPath: layout.vaultPath,
    gitMode: cfg.gitMode,
    agentProvider: process.env.AGENT_PROVIDER ?? "unset",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        listening: `http://${server.host}:${server.port}${cfg.path}`,
        wakeMode: cfg.wakeMode,
        vaultGitMode: cfg.gitMode,
        vault: layout.vaultPath,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
