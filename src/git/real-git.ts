import path from "node:path";
import type { GitOps, GitResult, ChangedPath } from "../types.js";
import { spawn } from "node:child_process";

export type RealGitOptions = {
  cwd: string;
  remote?: string;
};

function run(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c) => out.push(c as Buffer));
    child.stderr.on("data", (c) => err.push(c as Buffer));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function classifyGitFailure(stderr: string, stdout: string): GitResult {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  const conflict =
    text.includes("conflict") ||
    text.includes("converged") ||
    text.includes("needs merge") ||
    text.includes("unmerged");
  return {
    ok: false,
    reason: (stderr || stdout || "git failed").trim().slice(0, 500),
    conflict,
  };
}

export function createRealGit(opts: RealGitOptions): GitOps {
  const remote = opts.remote ?? "origin";
  const cwd = opts.cwd;

  return {
    async pull(): Promise<GitResult> {
      const r = await run(cwd, ["pull", "--rebase", remote]);
      if (r.code !== 0) return classifyGitFailure(r.stderr, r.stdout);
      return { ok: true };
    },
    async push(): Promise<GitResult> {
      const r = await run(cwd, ["push", remote]);
      if (r.code !== 0) return classifyGitFailure(r.stderr, r.stdout);
      return { ok: true };
    },
    async headRev(): Promise<string> {
      const r = await run(cwd, ["rev-parse", "HEAD"]);
      return r.stdout.trim() || "UNKNOWN";
    },
    async listChanges(): Promise<ChangedPath[]> {
      const r = await run(cwd, ["status", "--porcelain", "-uall"]);
      if (r.code !== 0) return [];
      const lines = r.stdout.split(/\r?\n/).filter(Boolean);
      const changes: ChangedPath[] = [];
      for (const line of lines) {
        const status = line.slice(0, 2).trim() || "??";
        let file = line.slice(3).trim();
        // renames: "R  old -> new"
        if (file.includes(" -> ")) {
          file = file.split(" -> ").pop()!.trim();
        }
        // untracked often '?? path'
        file = file.replace(/\\/g, "/").replace(/^"|"$/g, "");
        changes.push({ path: file, status: status.includes("D") ? "D" : status.includes("?") ? "A" : status });
      }
      return changes;
    },
    async add(paths: string[]): Promise<void> {
      if (paths.length === 0) return;
      // Also stage deletions
      await run(cwd, ["add", "-A", "--", ...paths]);
    },
    async commit(message: string): Promise<GitResult> {
      const r = await run(cwd, ["commit", "-m", message, "--allow-empty-message"]);
      // nothing to commit is ok-ish
      if (r.code !== 0) {
        if (/nothing to commit/i.test(r.stdout + r.stderr)) return { ok: true };
        return classifyGitFailure(r.stderr, r.stdout);
      }
      return { ok: true };
    },
    async restoreFromHead(relPath: string): Promise<void> {
      await run(cwd, ["checkout", "HEAD", "--", relPath]);
    },
  };
}

export function resolveVaultGit(cwd: string, remote?: string): GitOps {
  const opts: RealGitOptions = { cwd: path.resolve(cwd) };
  if (remote !== undefined) opts.remote = remote;
  return createRealGit(opts);
}
