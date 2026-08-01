import { describe, expect, it } from "vitest";
import { createMergedProcessorQueue } from "./queue.js";

describe("merged processor queue", () => {
  it("五次快速唤醒只合并通知，并持续 drain 剩余工作", async () => {
    let remaining = 5;
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const queue = createMergedProcessorQueue({
      yieldEveryRounds: 2,
      hasWork: async () => remaining > 0,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        remaining -= Math.min(2, remaining);
        active -= 1;
        return { status: "success", progressed: true };
      },
    });

    for (let i = 0; i < 5; i += 1) queue.enqueue();
    await queue.waitForIdle();

    expect(remaining).toBe(0);
    expect(runs).toBe(3);
    expect(maxActive).toBe(1);
  });

  it("空队列唤醒不启动处理轮", async () => {
    let runs = 0;
    const queue = createMergedProcessorQueue({
      hasWork: async () => false,
      run: async () => {
        runs += 1;
        return { status: "success", progressed: true };
      },
    });

    queue.enqueue();
    await queue.waitForIdle();

    expect(runs).toBe(0);
  });

  it("失败或无进展时停止 drain，下一次唤醒才重试", async () => {
    let runs = 0;
    const queue = createMergedProcessorQueue({
      hasWork: async () => true,
      run: async () => {
        runs += 1;
        return { status: "failed", progressed: false };
      },
    });

    queue.enqueue();
    await queue.waitForIdle();
    expect(runs).toBe(1);

    queue.enqueue();
    await queue.waitForIdle();
    expect(runs).toBe(2);
  });
});
