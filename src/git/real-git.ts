import path from "node:path";
import { rm } from "node:fs/promises";
import type {
  ChangedPath,
  GitResult,
  VaultAccess,
  VaultPublisher,
  VaultGitMode,
  VaultWorkspace,
} from "../types.js";
import { spawn } from "node:child_process";
import { createLocalVaultWorkspace } from "./local-vault.js";

export type RealGitOptions = {
  /** 真实日记 vault 仓根目录，不是工具仓目录。 */
  vaultPath: string;
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

function classifyGitFailure(
  stderr: string,
  stdout: string,
): Extract<GitResult, { ok: false }> {
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

export function createVaultWorkspace(opts: RealGitOptions): VaultWorkspace {
  const remote = opts.remote ?? "origin";
  const cwd = opts.vaultPath;

  return {
    async prepare(): Promise<GitResult> {
      const r = await run(cwd, ["pull", "--rebase", remote]);
      if (r.code !== 0) return classifyGitFailure(r.stderr, r.stdout);
      return { ok: true };
    },
    async listChanges(): Promise<ChangedPath[]> {
      const r = await run(cwd, ["status", "--porcelain", "-uall"]);
      if (r.code !== 0) return [];
      const lines = r.stdout.split(/\r?\n/).filter(Boolean);
      const changes: ChangedPath[] = [];
      for (const line of lines) {
        const status = line.slice(0, 2).trim() || "??";
        let file = line.slice(3).trim();
        let previousPath: string | undefined;
        // renames: "R  old -> new"
        if (file.includes(" -> ")) {
          const parts = file.split(" -> ");
          previousPath = parts[0]!.trim();
          file = parts[parts.length - 1]!.trim();
        }
        // untracked often '?? path'
        file = file.replace(/\\/g, "/").replace(/^"|"$/g, "");
        if (previousPath !== undefined) {
          previousPath = previousPath
            .replace(/\\/g, "/")
            .replace(/^"|"$/g, "");
        }
        changes.push({
          path: file,
          ...(previousPath !== undefined ? { previousPath } : {}),
          status: status.includes("D") ? "D" : status.includes("?") ? "A" : status,
        });
      }
      return changes;
    },
    async restore(relPath: string): Promise<void> {
      if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) return;
      const tracked = await run(cwd, ["cat-file", "-e", `HEAD:${relPath}`]);
      if (tracked.code === 0) {
        await run(cwd, ["checkout", "HEAD", "--", relPath]);
        return;
      }
      await rm(path.join(cwd, relPath), { force: true });
    },
  };
}

export function createVaultPublisher(opts: RealGitOptions): VaultPublisher {
  const remote = opts.remote ?? "origin";
  const cwd = opts.vaultPath;

  return {
    async publish(paths: string[], message: string): Promise<GitResult> {
      if (paths.length > 0) {
        const added = await run(cwd, ["add", "-A", "--", ...paths]);
        if (added.code !== 0) {
          return { ...classifyGitFailure(added.stderr, added.stdout), committed: false };
        }
      }

      const committed = await run(cwd, [
        "commit",
        "-m",
        message,
        "--allow-empty-message",
      ]);
      if (committed.code !== 0 && !/nothing to commit/i.test(committed.stdout + committed.stderr)) {
        return { ...classifyGitFailure(committed.stderr, committed.stdout), committed: false };
      }

      const pushed = await run(cwd, ["push", remote]);
      if (pushed.code !== 0) {
        return { ...classifyGitFailure(pushed.stderr, pushed.stdout), committed: true };
      }
      return { ok: true };
    },
  };
}

export function resolveVaultAccess(
  vaultPath: string,
  remote?: string,
  mode: VaultGitMode = "remote",
): VaultAccess {
  const resolvedVaultPath = path.resolve(vaultPath);
  if (mode === "local") {
    return { workspace: createLocalVaultWorkspace(resolvedVaultPath) };
  }

  const opts: RealGitOptions = { vaultPath: resolvedVaultPath };
  if (remote !== undefined) opts.remote = remote;
  return {
    workspace: createVaultWorkspace(opts),
    publisher: createVaultPublisher(opts),
  };
}
