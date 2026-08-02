import path from "node:path";
import { cleanupRuntimeLogs } from "../runtime/log-cleanup.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "用法：npm run logs:clean\n" +
        "环境变量：RUNTIME_LOG_DIR、LOG_RETENTION_MS（默认 15 分钟）",
    );
    return;
  }

  const directory = path.resolve(
    process.env.RUNTIME_LOG_DIR || "temp/runtime-logs",
  );
  const retentionMs = parseRetentionMs(process.env.LOG_RETENTION_MS);
  const result = await cleanupRuntimeLogs({ directory, retentionMs });
  console.log(
    JSON.stringify(
      {
        ok: true,
        directory,
        retentionMs,
        ...result,
      },
      null,
      2,
    ),
  );
}

function parseRetentionMs(raw: string | undefined): number {
  if (!raw) return 15 * 60_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("LOG_RETENTION_MS 必须是非负有限数字");
  }
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
