import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentContext, AgentRunner } from "../types.js";
import { pathExists } from "../vault/fs.js";
import { logAgentOutput, logError, logInfo } from "../runtime/log.js";

export type CliAgentSpec = {
  provider: string;
  bin: string;
  skill: string;
  extraArgs: string[];
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  buildArgs(prompt: string, extraArgs: string[]): string[];
};

/**
 * 在本处理环可见的契约上，两个 CLI 都是“改工作树并写回执”；provider 差异由各自 adapter 封装。
 */
export function createCliAgentRunner(spec: CliAgentSpec): AgentRunner {
  return {
    async run(ctx: AgentContext): Promise<void> {
      const prompt = buildProcessorPrompt(ctx, spec.skill);
      const args = spec.buildArgs(prompt, spec.extraArgs);

      await runCliProcess({
        provider: spec.provider,
        bin: spec.bin,
        args,
        cwd: ctx.vaultPath,
        env: spec.env,
        timeoutMs: spec.timeoutMs,
      });

      const receiptPath = path.join(
        ctx.vaultPath,
        ctx.layout.processorDir,
        "last-run.json",
      );
      if (!(await pathExists(receiptPath))) {
        throw new Error(
          `${spec.provider} agent 结束但缺少回执: ${ctx.layout.processorDir}/last-run.json`,
        );
      }
    },
  };
}

export function buildProcessorPrompt(ctx: AgentContext, skill: string): string {
  const list = ctx.pendingInbox.map((p) => `- ${p}`).join("\n");
  const inbox = ctx.layout.inboxDir;
  const diary = ctx.layout.diaryDir;
  const ideas = ctx.layout.ideasDir;
  const processor = ctx.layout.processorDir;
  const staging = ctx.layout.stagingDir;
  return [
    `请按 skill「${skill}」处理本轮收件箱（若工作区有 .claude/skills/${skill}/SKILL.md 请严格遵循）。`,
    "工作目录已是 vault 根目录。",
    `本轮待处理（最多 ${ctx.maxPerRound} 条，已由编排截取）：`,
    list || "（无）",
    "",
    "路径约定：",
    `- 日记前缀：${diary}/  → 文件 ${diary}/YYYY/YYYY-MM/YYYY-MM-DD.md`,
    `- 想法路径：${ideas}/短标题.md，文件必须直接位于该目录（一条一文件；v1 不归档）`,
    `- 日记树下的 ${ideas}/ 子目录不是想法目录，禁止在那里创建想法文件`,
    `- 收件箱：${inbox}/；状态与回执：${processor}/；同轮草稿：${staging}/`,
    "",
    "硬性约束：",
    `1. 只改白名单路径：${inbox}（勿删文件）、${staging}、${processor}、${diary}、${ideas}。`,
    "2. 不要执行 git commit / push / config。",
    `3. 不要删除 ${inbox} 下的文件；只在回执里声明 done/failed/quarantine。`,
    "4. 写回以日记为轴；可选想法并互链（日记=钩子+链接，想法=全文）；待查只打标。",
    "5. 轻整理：去赘词/重复、保语气；禁止升格代写、扩写未说内容、伪调研结论。",
    `6. 结束后必须写出 ${processor}/last-run.json（见 skill 中的 schema）。`,
    "7. 快照内每条 inbox 都必须在回执中交代，禁止漏报。",
  ].join("\n");
}

async function runCliProcess(opts: {
  provider: string;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const useWindowsShell = shouldUseWindowsShell(opts.bin);
    const spawnArgs = useWindowsShell
      ? opts.args.map(quoteWindowsShellArg)
      : opts.args;
    const child = spawn(opts.bin, spawnArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      shell: useWindowsShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    logInfo("agent.started", {
      provider: opts.provider,
      bin: opts.bin,
      cwd: opts.cwd,
      argCount: opts.args.length,
      shell: useWindowsShell,
    });
    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => {
      const buffer = chunk as Buffer;
      outputChunks.push(buffer);
      logAgentOutput(opts.provider, "stdout", buffer);
    });
    child.stderr.on("data", (chunk) => {
      const buffer = chunk as Buffer;
      errorChunks.push(buffer);
      logAgentOutput(opts.provider, "stderr", buffer);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      logError("agent.timeout", {
        provider: opts.provider,
        timeoutMs: opts.timeoutMs,
        durationMs: Date.now() - startedAt,
      });
      reject(new Error(`${opts.provider} agent 超时（${opts.timeoutMs}ms）`));
    }, opts.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      logError("agent.start_failed", {
        provider: opts.provider,
        bin: opts.bin,
        message: error.message,
      });
      reject(
        new Error(
          `${opts.provider} agent 启动失败: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      logInfo("agent.exited", {
        provider: opts.provider,
        code,
        durationMs: Date.now() - startedAt,
      });
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat(outputChunks).toString("utf8");
      const error = Buffer.concat(errorChunks).toString("utf8");
      const detail = `${error}\n${output}`.trim().slice(0, 1200);
      reject(new Error(`${opts.provider} agent 退出码 ${code}: ${detail}`));
    });
  });
}

/**
 * Node 在 Windows 以 shell 启动 .cmd 时不会替调用方保护带空格的参数。
 * prompt 是一个完整的多行参数，必须在交给 cmd.exe 前保留为单个参数。
 */
export function quoteWindowsShellArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;

  const escaped = value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function shouldUseWindowsShell(bin: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}
