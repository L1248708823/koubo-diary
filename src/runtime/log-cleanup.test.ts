import { mkdtemp as createTempDirectory, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRuntimeLogs,
  cleanupRuntimeLogsAfterSuccess,
} from "./log-cleanup.js";

describe("运行日志清理", () => {
  const directories: string[] = [];

  afterEach(async () => {
    while (directories.length > 0) {
      await rm(directories.pop()!, { recursive: true, force: true });
    }
  });

  it("成功清理时只删除超过保留期限的日志文件", async () => {
    const directory = await mkdtemp();
    const now = new Date("2026-08-01T12:00:00.000Z");
    const oldPath = path.join(directory, "old.log");
    const recentPath = path.join(directory, "recent.log");
    const notePath = path.join(directory, "keep.txt");
    await writeFile(oldPath, "old", "utf8");
    await writeFile(recentPath, "recent", "utf8");
    await writeFile(notePath, "keep", "utf8");
    await utimes(oldPath, new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 3_600_000));
    await utimes(recentPath, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));

    const result = await cleanupRuntimeLogsAfterSuccess({
      directory,
      enabled: true,
      retentionMs: 1_800_000,
      now,
    });

    expect(result.removed).toEqual(["old.log"]);
    expect(result.retained).toEqual(["recent.log"]);
    await expect(readFile(oldPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(recentPath, "utf8")).resolves.toBe("recent");
    await expect(readFile(notePath, "utf8")).resolves.toBe("keep");
  });

  it("未启用或目录未配置时不做任何删除", async () => {
    const directory = await mkdtemp();
    const logPath = path.join(directory, "old.log");
    await writeFile(logPath, "old", "utf8");

    expect(
      await cleanupRuntimeLogsAfterSuccess({
        directory,
        enabled: false,
        retentionMs: 0,
      }),
    ).toBeUndefined();
    await expect(readFile(logPath, "utf8")).resolves.toBe("old");
    expect(
      await cleanupRuntimeLogsAfterSuccess({
        enabled: true,
        retentionMs: 0,
      }),
    ).toBeUndefined();
  });

  it("日志目录不存在时按空目录处理", async () => {
    const directory = path.join(await mkdtemp(), "missing");
    const result = await cleanupRuntimeLogs({
      directory,
      retentionMs: 0,
    });

    expect(result).toEqual({ scanned: 0, removed: [], retained: [] });
  });

  async function mkdtemp(): Promise<string> {
    const directory = await createTempDirectory(
      path.join(os.tmpdir(), "koubo-log-cleanup-"),
    );
    directories.push(directory);
    return directory;
  }
});
