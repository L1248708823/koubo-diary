import { copyFile, mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少本地配置：${name}`);
  return value;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const repoRoot = process.cwd();
const vaultPath = path.resolve(requiredEnv("VAULT_PATH"));
const localConfigPath = path.join(repoRoot, "capture/public/local-config.js");

await mkdir(path.dirname(localConfigPath), { recursive: true });
await writeFile(
  localConfigPath,
  `window.__KOUBO_LOCAL_CONFIG__ = ${JSON.stringify({
    ingestUrl: `http://${requiredEnv("INGEST_HOST")}:${requiredEnv("INGEST_PORT")}${requiredEnv("INGEST_PATH")}`,
    ingestToken: requiredEnv("INGEST_TOKEN"),
  })};\n`,
  "utf8",
);

const vaultExists = await exists(vaultPath);
if (vaultExists) {
    console.log(`本地配置已更新：${localConfigPath}`);
    console.log("临时 vault 已存在，未覆盖现有测试现场。");
    process.exit(0);
}

await mkdir(vaultPath, { recursive: true });

const directories = [
  "_inbox",
  "_inbox/_quarantine",
  "_staging",
  "_processor",
  "想法",
  "生活/日子一天天过去",
  ".claude/skills/处理收件箱",
];
for (const directory of directories) {
  await mkdir(path.join(vaultPath, directory), { recursive: true });
}

await copyFile(
  path.join(repoRoot, "skills/处理收件箱/SKILL.md"),
  path.join(vaultPath, ".claude/skills/处理收件箱/SKILL.md"),
);

console.log(`本地测试 vault 已创建：${vaultPath}`);
console.log("本地模式不初始化 Git；下一步：启动 pnpm local:ingest 和 pnpm local:web，再打开捕捉页面。");
