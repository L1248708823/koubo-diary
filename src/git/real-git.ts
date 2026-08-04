import path from "node:path";
import { realpath, rm } from "node:fs/promises";
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
import { createFileLock, withExclusiveLock } from "../runtime/lock.js";
import type { Lock } from "../types.js";

export type RealGitOptions = {
  /** 真实日记 vault 仓根目录，不是工具仓目录。 */
  vaultPath: string;
  remote?: string;
  expectedRemoteUrl?: string;
  gitLockPath?: string;
};

type GitCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type GitCommandRunner = (args: string[]) => Promise<GitCommandResult>;

async function runGitCommand(
  cwd: string,
  args: string[],
): Promise<GitCommandResult> {
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

async function withGitTransaction<T>(
  lock: Lock | undefined,
  cwd: string,
  task: (run: GitCommandRunner) => Promise<T>,
): Promise<T> {
  const execute = () => task((args) => runGitCommand(cwd, args));
  if (!lock) return execute();
  return withExclusiveLock(lock, execute);
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
  const gitLock = opts.gitLockPath
    ? createFileLock(opts.gitLockPath)
    : undefined;

  return {
    async prepare(): Promise<GitResult> {
      return withGitTransaction(gitLock, cwd, async (run) => {
        const validation = await validateVaultRepository(
          cwd,
          remote,
          opts.expectedRemoteUrl,
          run,
        );
        if (validation) return validation;
        const r = await run(["pull", "--rebase", remote]);
        if (r.code !== 0) return classifyGitFailure(r.stderr, r.stdout);
        return { ok: true };
      });
    },
    async listChanges(): Promise<ChangedPath[]> {
      return withGitTransaction(gitLock, cwd, async (run) => {
        const validation = await validateVaultRepository(
          cwd,
          remote,
          opts.expectedRemoteUrl,
          run,
        );
        if (validation) throw new Error(`Git 仓库预检失败: ${validation.reason}`);
        const r = await run(["status", "--porcelain", "-uall"]);
        if (r.code !== 0) {
          const failure = classifyGitFailure(r.stderr, r.stdout);
          throw new Error(`git status 失败: ${failure.reason}`);
        }
        return parseChangedPaths(r.stdout);
      });
    },
    async restore(relPath: string): Promise<void> {
      if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
        throw new Error(`拒绝恢复非法路径: ${relPath}`);
      }
      await withGitTransaction(gitLock, cwd, async (run) => {
        const validation = await validateVaultRepository(
          cwd,
          remote,
          opts.expectedRemoteUrl,
          run,
        );
        if (validation) throw new Error(`Git 仓库预检失败: ${validation.reason}`);
        const tracked = await run([
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
          "--",
          relPath,
        ]);
        if (tracked.code !== 0) {
          const failure = classifyGitFailure(tracked.stderr, tracked.stdout);
          throw new Error(`git 恢复前查询失败: ${failure.reason}`);
        }
        if (tracked.stdout.trim().length > 0) {
          const restored = await run(["checkout", "HEAD", "--", relPath]);
          if (restored.code !== 0) {
            const failure = classifyGitFailure(restored.stderr, restored.stdout);
            throw new Error(`git checkout 恢复失败: ${failure.reason}`);
          }
          return;
        }
        await rm(path.join(cwd, relPath), { force: true });
      });
    },
  };
}

export function createVaultPublisher(opts: RealGitOptions): VaultPublisher {
  const remote = opts.remote ?? "origin";
  const cwd = opts.vaultPath;
  const gitLock = opts.gitLockPath
    ? createFileLock(opts.gitLockPath)
    : undefined;

  return {
    async publish(paths: string[], message: string): Promise<GitResult> {
      return withGitTransaction(gitLock, cwd, async (run) => {
        const validation = await validateVaultRepository(
          cwd,
          remote,
          opts.expectedRemoteUrl,
          run,
        );
        if (validation) return { ...validation, committed: false };
        if (paths.length > 0) {
          const added = await run(["add", "-A", "--", ...paths]);
          if (added.code !== 0) {
            return { ...classifyGitFailure(added.stderr, added.stdout), committed: false };
          }
        }

        const committed = await run([
          "commit",
          "-m",
          message,
          "--allow-empty-message",
        ]);
        if (committed.code !== 0 && !/nothing to commit/i.test(committed.stdout + committed.stderr)) {
          return { ...classifyGitFailure(committed.stderr, committed.stdout), committed: false };
        }

        const pushed = await run(["push", remote]);
        if (pushed.code !== 0) {
          return { ...classifyGitFailure(pushed.stderr, pushed.stdout), committed: true };
        }
        return { ok: true };
      });
    },
  };
}

export function resolveVaultAccess(
  vaultPath: string,
  remote?: string,
  mode: VaultGitMode = "remote",
  expectedRemoteUrl?: string,
  gitLockPath?: string,
): VaultAccess {
  const resolvedVaultPath = path.resolve(vaultPath);
  if (mode === "local") {
    return { workspace: createLocalVaultWorkspace(resolvedVaultPath) };
  }

  const opts: RealGitOptions = {
    vaultPath: resolvedVaultPath,
    ...(remote !== undefined ? { remote } : {}),
    ...(expectedRemoteUrl !== undefined ? { expectedRemoteUrl } : {}),
    ...(gitLockPath !== undefined ? { gitLockPath } : {}),
  };
  return {
    workspace: createVaultWorkspace(opts),
    publisher: createVaultPublisher(opts),
  };
}

export function normalizeRemoteUrl(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed.startsWith("git@") && trimmed.includes(":")) {
    const separator = trimmed.indexOf(":");
    return `${trimmed.slice(4, separator)}/${trimmed.slice(separator + 1)}`
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}/${parsed.pathname.replace(/^\/+/, "")}`
      .replace(/\.git$/i, "")
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();
  } catch {
    return trimmed.replace(/\.git$/i, "").replace(/\/+$/g, "").toLowerCase();
  }
}

async function validateVaultRepository(
  cwd: string,
  remote: string,
  expectedRemoteUrl: string | undefined,
  run: GitCommandRunner,
): Promise<Extract<GitResult, { ok: false }> | undefined> {
  const root = await run(["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) return classifyGitFailure(root.stderr, root.stdout);
  if (!(await samePath(root.stdout.trim(), cwd))) {
    return {
      ok: false,
      reason: `VAULT_PATH 不是 Git 仓根目录: ${root.stdout.trim()}`,
    };
  }

  const fetchUrl = await run(["remote", "get-url", remote]);
  if (fetchUrl.code !== 0) return classifyGitFailure(fetchUrl.stderr, fetchUrl.stdout);
  const pushUrl = await run(["remote", "get-url", "--push", remote]);
  if (pushUrl.code !== 0) return classifyGitFailure(pushUrl.stderr, pushUrl.stdout);

  if (expectedRemoteUrl) {
    const expected = normalizeRemoteUrl(expectedRemoteUrl);
    for (const [kind, actual] of [
      ["fetch", fetchUrl.stdout],
      ["push", pushUrl.stdout],
    ] as const) {
      if (normalizeRemoteUrl(actual) !== expected) {
        return {
          ok: false,
          reason: `日记仓 ${kind} remote 不匹配: ${actual.trim()}`,
        };
      }
    }
  }
  return undefined;
}

async function samePath(left: string, right: string): Promise<boolean> {
  const normalize = (value: string) =>
    path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  let resolvedLeft = left;
  let resolvedRight = right;
  try {
    [resolvedLeft, resolvedRight] = await Promise.all([
      realpath(left),
      realpath(right),
    ]);
  } catch {
    /* Git already confirmed the repository root; fall back to normalized paths. */
  }
  const normalizedLeft = normalize(resolvedLeft);
  const normalizedRight = normalize(resolvedRight);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function parseChangedPaths(stdout: string): ChangedPath[] {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const changes: ChangedPath[] = [];
  for (const line of lines) {
    const status = line.slice(0, 2).trim() || "??";
    let file = line.slice(3).trim();
    let previousPath: string | undefined;
    if (file.includes(" -> ")) {
      const parts = file.split(" -> ");
      previousPath = parts[0]!.trim();
      file = parts[parts.length - 1]!.trim();
    }
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
}
