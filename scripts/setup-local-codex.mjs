import { cp, mkdir, access, writeFile } from "node:fs/promises";
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
await mkdir(vaultPath, { recursive: true });

const directories = [
  "_inbox",
  "_inbox/_quarantine",
  "_staging",
  "_processor",
  "Yan帳/想法",
  "Yan帳/研究",
  "生活/日子一天天过去",
];
for (const directory of directories) {
  await mkdir(path.join(vaultPath, directory), { recursive: true });
}

const codexSkillsDir = path.join(vaultPath, ".codex/skills");
await mkdir(codexSkillsDir, { recursive: true });
for (const skillName of ["处理收件箱", "research-brief", "research-explore"]) {
  await cp(
    path.join(repoRoot, "skills", skillName),
    path.join(codexSkillsDir, skillName),
    { recursive: true },
  );
}

console.log(`本地配置已更新：${localConfigPath}`);
if (vaultExists) {
  console.log("临时 vault 已存在，已补齐目录，保留现有测试内容。");
} else {
  console.log(`本地测试 vault 已创建：${vaultPath}`);
}
console.log("本地模式不初始化 Git；下一步：启动 npm.cmd run local:ingest 和 npm.cmd run local:web，再打开捕捉页面。");
