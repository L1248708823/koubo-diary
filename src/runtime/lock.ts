import { mkdir, writeFile, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Lock, LockHandle } from "../types.js";
import { logInfo } from "./log.js";

/**
 * 文件锁（VPS 本地路径，不进 git）。
 * 用 O_EXCL 创建锁文件；持有进程退出后需人工或启动脚本清理陈旧锁。
 */
export function createFileLock(lockPath: string): Lock {
  return {
    async tryAcquire(): Promise<LockHandle | null> {
      await mkdir(path.dirname(lockPath), { recursive: true });
      try {
        const fh = await open(lockPath, "wx");
        await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        await fh.close();
        logInfo("lock.acquired", { lockPath });
        return {
          async release() {
            await rm(lockPath, { force: true });
            logInfo("lock.released", { lockPath });
          },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          let owner: string | undefined;
          try {
            owner = (await readFile(lockPath, "utf8")).trim();
          } catch {
            /* 锁文件可能刚好被释放。 */
          }
          logInfo("lock.busy", { lockPath, owner });
          return null;
        }
        throw err;
      }
    },
  };
}

/** 写唤醒 flag；编排或旁路 watcher 可感知。 */
export async function touchWakeFlag(flagPath: string): Promise<void> {
  await mkdir(path.dirname(flagPath), { recursive: true });
  await writeFile(flagPath, `${new Date().toISOString()}\n`, "utf8");
}

export async function clearWakeFlag(flagPath: string): Promise<void> {
  await rm(flagPath, { force: true });
}
