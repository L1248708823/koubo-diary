import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCliAgentRunner } from "./cli-runner.js";
import type { AgentRunner } from "../types.js";

export type CodexAgentOptions = {
  /** Windows 通常填 codex.cmd；Linux/WSL 通常填 codex。 */
  bin?: string;
  skill?: string;
  model?: string;
  reasoningEffort?: string;
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
  const model =
    options.model ?? process.env.PROCESSOR_MODEL ?? "gpt-5.6-luna";
  const reasoningEffort =
    options.reasoningEffort ??
    process.env.PROCESSOR_REASONING_EFFORT ??
    "max";

  return createCliAgentRunner({
    provider: "Codex",
    bin,
    skill,
    extraArgs: options.extraArgs ?? [],
    env: options.env,
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    promptTransport: "stdin",
    buildArgs(_prompt, extraArgs) {
      return buildCodexAgentArgs({
        model,
        reasoningEffort,
        skill,
        networkAccess: true,
        extraArgs,
      });
    },
  });
}

export function buildCodexAgentArgs(args: {
  model: string;
  reasoningEffort: string;
  skill?: string;
  networkAccess?: boolean;
  extraArgs?: string[];
}): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "workspace-write",
    "-m",
    args.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(args.reasoningEffort)}`,
    ...(args.networkAccess
      ? ["-c", "sandbox_workspace_write.network_access=true"]
      : []),
    ...(args.skill
      ? ["-c", buildCodexSkillConfig(args.skill)]
      : []),
    ...(args.extraArgs ?? []),
  ];
}

export function buildCodexSkillConfig(skill: string): string {
  const skillsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../skills",
  );
  const skillPath = path.resolve(skillsRoot, skill, "SKILL.md");
  const relative = path.relative(skillsRoot, skillPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Codex skill path is outside the skills directory: ${skill}`);
  }
  return `skills.config=[{path=${JSON.stringify(skillPath)},enabled=true}]`;
}
