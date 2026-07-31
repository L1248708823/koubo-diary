import { createCliAgentRunner } from "./cli-runner.js";
import type { AgentRunner } from "../types.js";

export type CodexAgentOptions = {
  /** Windows 通常填 codex.cmd；Linux/WSL 通常填 codex。 */
  bin?: string;
  skill?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export function createCodexAgentRunner(
  options: CodexAgentOptions = {},
): AgentRunner {
  const bin =
    options.bin ??
    process.env.CODEX_BIN ??
    (process.platform === "win32" ? "codex.cmd" : "codex");
  const skill = options.skill ?? process.env.PROCESSOR_SKILL ?? "处理收件箱";

  return createCliAgentRunner({
    provider: "Codex",
    bin,
    skill,
    extraArgs: options.extraArgs ?? [],
    env: options.env,
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    buildArgs(prompt, extraArgs) {
      return [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "workspace-write",
        ...extraArgs,
        prompt,
      ];
    },
  });
}
