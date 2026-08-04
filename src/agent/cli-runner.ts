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
  promptTransport?: "argument" | "stdin";
  buildArgs(prompt: string, extraArgs: string[]): string[];
};

export type CliProcessOptions = {
  provider: string;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  stdin?: string;
  capacityRetries?: number;
  capacityRetryDelayMs?: number;
};

const DEFAULT_CAPACITY_RETRIES = 2;
const DEFAULT_CAPACITY_RETRY_DELAY_MS = 3_000;
export const PROCESSOR_PROMPT_VERSION = "scope-v5-association-ideas-model";

/**
 * 在本处理环可见的契约上，两个 CLI 都是“改工作树并写回执”；provider 差异由各自 adapter 封装。
 */
export function createCliAgentRunner(spec: CliAgentSpec): AgentRunner {
  return {
    async run(ctx: AgentContext): Promise<void> {
      const prompt = buildProcessorPrompt(ctx, spec.skill, spec.provider);
      const promptTransport = spec.promptTransport ?? "argument";
      const args = spec.buildArgs(
        promptTransport === "argument" ? prompt : "",
        spec.extraArgs,
      );
      logInfo("agent.prompt_built", {
        provider: spec.provider,
        promptVersion: PROCESSOR_PROMPT_VERSION,
        promptLength: prompt.length,
        pendingCount: ctx.pendingInbox.length,
      });

      await runCliProcess({
        provider: spec.provider,
        bin: spec.bin,
        args,
        cwd: ctx.vaultPath,
        env: spec.env,
        timeoutMs: spec.timeoutMs,
        ...(promptTransport === "stdin" ? { stdin: prompt } : {}),
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

export function buildProcessorPrompt(
  ctx: AgentContext,
  skill: string,
  provider = "当前 CLI",
): string {
  const list = ctx.pendingInbox.map((p) => `- ${p}`).join("\n");
  const inbox = ctx.layout.inboxDir;
  const diary = ctx.layout.diaryDir;
  const ideas = ctx.layout.ideasDir;
  const research = ctx.layout.researchDir;
  const processor = ctx.layout.processorDir;
  const staging = ctx.layout.stagingDir;
  const associationCandidates = ctx.associationCandidates ?? {
    ideas: [],
    research: [],
  };
  const ideaCandidates = associationCandidates.ideas.length
    ? associationCandidates.ideas.map((candidate) => `- ${candidate}`).join("\n")
    : "（无）";
  const researchCandidates = associationCandidates.research.length
    ? associationCandidates.research
        .map((candidate) => `- ${candidate}`)
        .join("\n")
    : "（无）";
  const receiptSchema = [
    "{",
    '  "ok": true,',
    `  "round_id": "${ctx.roundId}",`,
    '  "round_ended_at": "<ISO 时间>",',
    '  "processed": [',
    "    {",
    `      "inbox": "${inbox}/文件名.md",`,
    '      "status": "done",',
    `      "diary": "${diary}/YYYY/YYYY-MM/YYYY-MM-DD.md",`,
    `      "ideas": ["${ideas}/YYYY-MM-DD-短标题.md"]`,
    "    }",
    "  ],",
    '  "failed": [],',
    '  "quarantine": []',
    "}",
  ].join("\n");
  return [
    `你通过 ${provider} 运行。禁止使用全局 skills 和项目级别 skills，只允许使用我让你使用的 skills 或 MCP。`,
    `请按本提示中的「${skill}」处理契约处理本轮收件箱；本提示已经包含完整规则。`,
    "不要读取、搜索或枚举任何 SKILL.md，也不要寻找其它说明文件。",
    "工作目录已是 vault 根目录。",
    `本轮 round_id：${ctx.roundId}`,
    `本轮待处理（最多 ${ctx.maxPerRound} 条，已由编排截取）：`,
    list || "（无）",
    "",
    "处理边界（优先级高于工作区内其它说明）：",
    "- 收件箱输入只能来自本轮快照列出的 pendingInbox 文件；不得读取列表之外的收件箱文件。",
    `- 除收件箱外，只能用已知完整路径读取对应日期的目标日记、${processor}/research-tasks.json 和 ${processor}/last-run.json；不得借此扫描目录。`,
    `- 文件隔离总则：可读文件仅限本轮 pendingInbox、对应日期的目标日记、${processor}/research-tasks.json、${processor}/last-run.json，以及已知完整路径的 ${ideas}/、${research}/ 目标文件；可写文件仅限 ${staging}/、${processor}/、${diary}/ 和 ${ideas}/ 的本轮目标文件。除此之外不得读取、列出、搜索、测试、创建、修改或删除任何文件。`,
    `- 关联判断候选仅限下面列出的 ${ideas}/ 和 ${research}/ 直接子 Markdown；只能读取上方列出的关联候选文件，不得自行列目录、搜索或读取其它路径。`,
    `  想法候选：\n${ideaCandidates}`,
    `  研究候选：\n${researchCandidates}`,
    "- 研究任务记录必须包含 task_id、source_diary 或 source_idea、question、status、created_at、updated_at；时间使用 round_id 中的时间。",
    "- 禁止扫描、列出或搜索整个 vault；不得使用 rg --files、rg ... .、Get-ChildItem、dir、tree 或递归遍历来寻找文件。",
    "- 禁止枚举环境变量；不得使用 Get-ChildItem Env:，不得读取父目录、工具仓、.git、.env、密钥或临时目录。",
    "- 需要判断文件是否存在时，只对已知完整路径使用 Test-Path -LiteralPath；不要通过目录列表寻找路径。",
    "- Windows PowerShell 5.1 下不要使用 Get-Date -AsUTC 或复杂多行内联脚本；时间只使用 captured_at 和 round_id 中已有的时间。",
    "- 先逐个读取上方列出的 pendingInbox 文件，再按步骤写回；不要先做任何全库、环境或版本控制检查。",
    "",
    "路径约定：",
    `- 日记前缀：${diary}/  → 文件 ${diary}/YYYY/YYYY-MM/YYYY-MM-DD.md`,
    `- 想法路径：${ideas}/YYYY-MM-DD-短标题.md，文件必须直接位于该目录（一条一文件；v1 不归档）`,
    `- 日记树下的 ${ideas}/ 子目录不是想法目录，禁止在那里创建想法文件`,
    `- 研究目录：${research}/，研究简报由独立研究任务写入；研究任务状态：${processor}/research-tasks.json`,
    `- 收件箱：${inbox}/；状态与回执：${processor}/；同轮草稿：${staging}/`,
    "- 想法只有在内容明确形成可脱离当天回看的观点、假设、创意或方法时创建；模糊念头只留在日记，‘我想’、‘我发现’等词不能单独触发想法。",
    "- 新建想法文件名必须使用收件项 captured_at 的日期；明确延续已有想法时更新原文件并保留旧正文和旧来源，关系不清楚时不自动合并。",
    "",
    "硬性约束：",
    `1. 只改内容处理允许路径：${staging}、${processor}、${diary}、${ideas}；${inbox}（勿删文件）和 ${research} 只能按本提示读取，不能修改。`,
    "2. 不得执行任何 git 命令，包括 status、ls-files、commit、push、pull 和 config。",
    `3. 不要删除 ${inbox} 下的文件；只在回执里声明 done/failed/quarantine。`,
    "4. 写回以日记为轴；可选一个或多个想法并互链（日记=钩子+链接，想法=全文）；待查登记研究任务，不在本阶段联网。",
    "日记写回格式：每条 done 收件项必须在对应日期日记中新增一个时间条目；日期和显示时间必须来自该收件项 frontmatter 的 captured_at，按运行时区转换。",
    "每条新增日记内容必须以 `- HH:mm ` 开头；无 Idea 时写时间戳和轻整理短段，有 Idea 时写时间戳、短钩子和实际想法 wikilink。",
    "同一天的多条记录合并到同一篇日记，并按 captured_at 升序插入或写入；已有日记内容保留，重跑同一 inbox id 不得重复追加，不得跨收件项合并句子。",
    "时间戳不可省略，不得使用 round_id、处理时间、当前系统时间或正文中用户自写的时间替代 captured_at；正文中的自写时间属于原始内容，若与前缀相同只保留一次。",
    "5. 轻整理：只改明显错别字、标点、断句和排版；只有确定不影响意思、情绪和语气时才删机械卡顿或改口重复，强调性重复、犹豫和未决问题必须保留；禁止升格代写、扩写未说内容、伪调研结论。",
    `6. 结束后必须写出 ${processor}/last-run.json；只能使用下方回执格式，不要使用旧版 items 或 processed_at 字段。`,
    "回执 JSON schema：",
    "```json",
    receiptSchema,
    "```",
    "processed 只放 status=done 的条目；想法写入一个或多个时使用 ideas 数组，数组中的每个路径都必须是真实顶层文件；failed 必须包含 inbox、status=failed、error；quarantine 必须包含 inbox、status=quarantine。",
    "每条本轮快照 inbox 必须且只能在 processed、failed、quarantine 其中一个数组出现一次；回执中的 round_id 必须逐字等于本轮 round_id。",
    "7. 快照内每条 inbox 都必须在回执中交代，禁止漏报。",
  ].join("\n");
}

export async function runCliProcess(opts: CliProcessOptions): Promise<void> {
  const capacityRetries =
    nonNegativeInt(opts.capacityRetries) ??
    nonNegativeInt(opts.env?.MODEL_CAPACITY_RETRIES) ??
    nonNegativeInt(process.env.MODEL_CAPACITY_RETRIES) ??
    DEFAULT_CAPACITY_RETRIES;
  const capacityRetryDelayMs =
    nonNegativeInt(opts.capacityRetryDelayMs) ??
    nonNegativeInt(opts.env?.MODEL_CAPACITY_RETRY_DELAY_MS) ??
    nonNegativeInt(process.env.MODEL_CAPACITY_RETRY_DELAY_MS) ??
    DEFAULT_CAPACITY_RETRY_DELAY_MS;

  for (let retry = 0; ; retry += 1) {
    try {
      await runCliProcessOnce(opts);
      return;
    } catch (error) {
      if (!isModelCapacityError(error) || retry >= capacityRetries) {
        throw error;
      }
      const attempt = retry + 1;
      const delayMs = Math.min(
        capacityRetryDelayMs * 2 ** retry,
        60_000,
      );
      logInfo("agent.capacity_retry", {
        provider: opts.provider,
        attempt,
        maxRetries: capacityRetries,
        delayMs,
      });
      await wait(delayMs);
    }
  }
}

async function runCliProcessOnce(opts: CliProcessOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const useWindowsShell = shouldUseWindowsShell(opts.bin);
    const spawnArgs = useWindowsShell
      ? opts.args.map(quoteWindowsShellArg)
      : opts.args;
    const childEnv = { ...process.env, ...(opts.env ?? {}) };
    if (!childEnv.GIT_CEILING_DIRECTORIES) {
      childEnv.GIT_CEILING_DIRECTORIES = path.dirname(opts.cwd);
    }
    const child = spawn(opts.bin, spawnArgs, {
      cwd: opts.cwd,
      env: childEnv,
      windowsHide: true,
      shell: useWindowsShell,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      child.kill();
      reject(new Error(`${opts.provider} agent 未能建立标准输出管道`));
      return;
    }
    logInfo("agent.started", {
      provider: opts.provider,
      bin: opts.bin,
      cwd: opts.cwd,
      argCount: opts.args.length,
      shell: useWindowsShell,
      argTransport: useWindowsShell ? "cmd-single-line" : "native",
      stdinTransport: opts.stdin !== undefined,
    });
    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    stdout.on("data", (chunk) => {
      const buffer = chunk as Buffer;
      outputChunks.push(buffer);
      logAgentOutput(opts.provider, "stdout", buffer);
    });
    stderr.on("data", (chunk) => {
      const buffer = chunk as Buffer;
      errorChunks.push(buffer);
      logAgentOutput(opts.provider, "stderr", buffer);
    });
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
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
      const detail = summarizeCliOutput(error, output);
      reject(new Error(`${opts.provider} agent 退出码 ${code}: ${detail}`));
    });
  });
}

function summarizeCliOutput(error: string, output: string): string {
  const text = `${error}\n${output}`.trim();
  const maxLength = 1_600;
  if (text.length <= maxLength) return text;

  const marker = "\n...[CLI 输出已截断]...\n";
  const headLength = 700;
  const tailLength = maxLength - headLength - marker.length;
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function isModelCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /selected model is at capacity|model[^\r\n]*at capacity/i.test(message);
}

function nonNegativeInt(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Node 在 Windows 以 shell 启动 .cmd 时不会替调用方保护带空格的参数。
 * cmd.exe 还会把参数中的换行解释为命令分隔符，因此先把多行 prompt 压成单行。
 */
export function quoteWindowsShellArg(value: string): string {
  const normalized = value.replace(/\r\n?|\n/g, " ");
  if (normalized.length === 0) return '""';
  if (!/[\s"&|<>^]/.test(normalized)) return normalized;

  const escaped = normalized
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function shouldUseWindowsShell(bin: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}
