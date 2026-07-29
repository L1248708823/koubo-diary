/**
 * 真 Claude Code agent runner 骨架。
 * 无 CLAUDE_BIN / 凭证时不要在 CI 里跑；用假 agent 锁编排契约。
 *
 * 约定：
 * - 工作目录 = vault clone
 * - 非交互调用 skill「处理收件箱」
 * - agent 只改工作树并写 `_processor/last-run.json`
 * - 禁止 git commit/push、禁止删 inbox（由编排脚本验收后删除）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentRunner, AgentContext } from "../types.js";
import { pathExists } from "../vault/fs.js";

export type ClaudeAgentOptions = {
  /** claude 可执行文件，默认环境变量 CLAUDE_BIN 或 "claude" */
  bin?: string;
  /** skill 名称或提示词入口 */
  skill?: string;
  /** 额外参数，例如 ["-p", "--output-format", "json"] 视实际 CLI 而定 */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export function createClaudeAgentRunner(
  options: ClaudeAgentOptions = {},
): AgentRunner {
  const bin = options.bin ?? process.env.CLAUDE_BIN ?? "claude";
  const skill = options.skill ?? process.env.PROCESSOR_SKILL ?? "处理收件箱";
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  return {
    async run(ctx: AgentContext): Promise<void> {
      const prompt = buildPrompt(ctx, skill);
      const args = [
        "-p",
        prompt,
        ...(options.extraArgs ?? []),
      ];

      await exec(bin, args, {
        cwd: ctx.vaultPath,
        env: { ...process.env, ...options.env },
        timeoutMs,
      });

      const receiptPath = path.join(
        ctx.vaultPath,
        ctx.layout.processorDir,
        "last-run.json",
      );
      if (!(await pathExists(receiptPath))) {
        throw new Error(
          `Claude agent 结束但缺少回执: ${ctx.layout.processorDir}/last-run.json`,
        );
      }
    },
  };
}

function buildPrompt(ctx: AgentContext, skill: string): string {
  const list = ctx.pendingInbox.map((p) => `- ${p}`).join("\n");
  return [
    `请按 skill「${skill}」处理本轮收件箱。`,
    `工作目录已是 vault 根目录。`,
    `本轮待处理（最多 ${ctx.maxPerRound} 条，已由编排截取）：`,
    list || "（无）",
    "",
    "硬性约束：",
    "1. 只改白名单路径：_inbox（勿删文件）、_staging、_processor、日记、想法。",
    "2. 不要执行 git commit / push / config。",
    "3. 不要删除 _inbox 下的文件；只在回执里声明 done/failed/quarantine。",
    "4. 写回以日记为轴；可选想法笔记并互链；待查只打标。",
    "5. 轻整理：去赘词/重复、保语气；禁止升格代写、扩写未说内容、伪调研结论。",
    "6. 结束后必须写出 `_processor/last-run.json`（见 skill 中的 schema）。",
  ].join("\n");
}

function exec(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errChunks: Buffer[] = [];
    child.stderr.on("data", (c) => errChunks.push(c as Buffer));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude agent 超时（${opts.timeoutMs}ms）`));
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const stderr = Buffer.concat(errChunks).toString("utf8").slice(0, 800);
        reject(new Error(`Claude agent 退出码 ${code}: ${stderr}`));
      }
    });
  });
}
