import { describe, expect, it } from "vitest";
import type { Lock, LockHandle } from "../types.js";
import { withExclusiveLock } from "./lock.js";

describe("exclusive lock helper", () => {
  it("短暂占用时等待后执行并释放", async () => {
    let attempts = 0;
    let released = false;
    const lock: Lock = {
      async tryAcquire(): Promise<LockHandle | null> {
        attempts += 1;
        if (attempts < 3) return null;
        return {
          async release() {
            released = true;
          },
        };
      },
    };

    await expect(
      withExclusiveLock(lock, async () => "ok", {
        retryDelayMs: 0,
        timeoutMs: 100,
      }),
    ).resolves.toBe("ok");
    expect(attempts).toBe(3);
    expect(released).toBe(true);
  });

  it("持续占用超过等待时间时明确失败", async () => {
    const lock: Lock = {
      async tryAcquire(): Promise<LockHandle | null> {
        return null;
      },
    };

    await expect(
      withExclusiveLock(lock, async () => "never", {
        retryDelayMs: 0,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("锁等待超时");
  });
});
