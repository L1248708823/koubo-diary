/**
 * 收件 HTTP CLI。
 *
 *   INGEST_TOKEN=... VAULT_PATH=... npm run ingest
 *
 * 投递成功后默认写 WAKE_FLAG_PATH；可用 WAKE_MODE=none 关闭。
 * 同机编排可用旁路 watch flag，或 systemctl --no-block。
 */
import { loadLayoutFromEnv, loadIngestConfigFromEnv } from "../env.js";
import { resolveVaultGit } from "../git/real-git.js";
import { createIngestServer } from "../ingest/server.js";
import { touchWakeFlag } from "../runtime/lock.js";
import { ensureVaultDirs } from "../vault/fs.js";

async function main(): Promise<void> {
  const layout = loadLayoutFromEnv();
  const cfg = loadIngestConfigFromEnv();
  await ensureVaultDirs(layout);
  const git = resolveVaultGit(layout.vaultPath, cfg.gitRemote);

  const server = await createIngestServer({
    layout,
    token: cfg.token,
    git,
    clock: { now: () => new Date() },
    host: cfg.host,
    port: cfg.port,
    path: cfg.path,
    onWake: async () => {
      if (cfg.wakeMode === "none") return;
      if (cfg.wakeMode === "file") {
        await touchWakeFlag(cfg.wakeFlagPath);
        return;
      }
      // callback 模式留给同进程嵌入；CLI 默认 file
      await touchWakeFlag(cfg.wakeFlagPath);
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        listening: `http://${server.host}:${server.port}${cfg.path}`,
        wakeMode: cfg.wakeMode,
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
