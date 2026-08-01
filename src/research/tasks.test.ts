import { afterEach, describe, expect, it } from "vitest";
import {
  createResearchTask,
  readResearchTasks,
  recoverRunningResearchTasks,
  writeResearchTasks,
} from "./tasks.js";
import { createTempVault, type TempVault } from "../testkit/temp-vault.js";

describe("research task state", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("同一来源与问题只保留最新任务", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const first = createResearchTask({
      taskId: "task-old",
      sourceDiary: "生活/日子一天天过去/2026/2026-07/2026-07-31.md",
      question: "如何验证这个想法？",
      now: "2026-07-31T10:00:00.000Z",
    });
    const newer = {
      ...first,
      task_id: "task-new",
      status: "partial" as const,
      updated_at: "2026-07-31T11:00:00.000Z",
    };

    await writeResearchTasks(vault.layout, [first, newer]);

    const tasks = await readResearchTasks(vault.layout);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task_id).toBe("task-new");
    expect(tasks[0]?.status).toBe("partial");
  });

  it("恢复中断的 running 任务为 pending", () => {
    const task = createResearchTask({
      taskId: "task-running",
      sourceIdea: "Yan帳/想法/一个想法.md",
      question: "需要核实什么？",
      now: "2026-07-31T10:00:00.000Z",
    });
    const recovered = recoverRunningResearchTasks([
      { ...task, status: "running" },
    ]);

    expect(recovered[0]?.status).toBe("pending");
  });
});
