import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  countPendingResearchTasks,
  countRunnableResearchTasks,
  countUnfinishedResearchTasks,
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

  it("未完成数量包含 partial 和 blocked，可重试数量单独保留", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const now = "2026-07-31T10:00:00.000Z";
    const task = (taskId: string, status: "pending" | "partial" | "blocked" | "running" | "complete") => ({
      ...createResearchTask({
        taskId,
        sourceIdea: `Yan帳/想法/${taskId}.md`,
        question: `问题 ${taskId}`,
        now,
      }),
      status,
    });
    await writeResearchTasks(vault.layout, [
      task("task-pending", "pending"),
      task("task-partial", "partial"),
      task("task-blocked", "blocked"),
      task("task-running", "running"),
      task("task-complete", "complete"),
    ]);

    await expect(countPendingResearchTasks(vault.layout)).resolves.toBe(2);
    await expect(countUnfinishedResearchTasks(vault.layout)).resolves.toBe(4);
    await expect(countRunnableResearchTasks(vault.layout)).resolves.toBe(4);
  });

  it("兼容旧版缺少时间字段的研究任务，并补齐时间", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const taskFile = path.join(
      vault.root,
      vault.layout.processorDir,
      "research-tasks.json",
    );
    await writeFile(
      taskFile,
      JSON.stringify([
        {
          task_id: "legacy-task",
          source_diary: "生活/日子一天天过去/2026/2026-08/2026-08-01.md",
          question: "旧任务还能继续研究吗？",
          status: "pending",
        },
      ]),
      "utf8",
    );

    const tasks = await readResearchTasks(vault.layout);

    expect(tasks[0]).toMatchObject({
      task_id: "legacy-task",
      status: "pending",
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(tasks[0]?.created_at).toBe(tasks[0]?.updated_at);
  });
});
