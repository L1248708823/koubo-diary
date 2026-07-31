import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { pathExists, listPendingInbox } from "../vault/fs.js";
import {
  createTempVault,
  createMemoryLock,
  createFakeVaultAccess,
  createFakeAgent,
  fixedClock,
  writeDiary,
  type TempVault,
} from "../testkit/temp-vault.js";
import { createIngestServer, type IngestServer } from "../ingest/server.js";
import { createLocalInboxDelivery } from "../ingest/delivery.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import type { AgentRunner, Lock } from "../types.js";

describe("ingest wakes processor (seam 3)", () => {
  const vaults: TempVault[] = [];
  const servers: IngestServer[] = [];

  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      if (s) await s.close();
    }
    while (vaults.length) {
      const v = vaults.pop();
      if (v) await v.cleanup();
    }
  });

  it("合法投递后唤醒处理轮：假 agent 写回日记并脚本清理 inbox；响应仍只 delivered", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const lock = createMemoryLock();
    const { workspace, captureHead } = await createFakeVaultAccess(vault.layout);
    const clock = fixedClock("2026-07-29T15:30:12+08:00");

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      const processed = [];
      for (const inbox of pendingInbox) {
        const diary = await writeDiary(
          layout,
          "2026/2026-07/2026-07-29.md",
          `## 15:30\n\n整理后的口播\n\n来源: ${inbox}\n`,
        );
        processed.push({
          inbox,
          status: "done" as const,
          diary,
        });
      }
      return {
        ok: true,
        round_ended_at: "2026-07-29T15:31:00+08:00",
        processed,
        failed: [],
        quarantine: [],
      };
    });

    let roundPromise: Promise<unknown> | null = null;
    const wakes: string[] = [];

    const server = await createIngestServer({
      token: "wake-token",
      delivery: createLocalInboxDelivery(vault.layout, clock),
      clock,
      path: "/ingest",
      host: "127.0.0.1",
      port: 0,
      onWake: async () => {
        wakes.push("wake");
        await captureHead();
        // 同步化：测试里直接排队跑编排（生产可写 flag / systemctl）
        roundPromise = runProcessorRound({
          options: vault.options,
          workspace,
          lock,
          agent,
          clock,
        });
      },
    });
    servers.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wake-token",
      },
      body: JSON.stringify({ text: "投递并叫醒整理" }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      delivered: boolean;
      id: string;
      organized?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.delivered).toBe(true);
    expect(body.organized).toBeUndefined();
    expect(wakes).toEqual(["wake"]);
    expect(roundPromise).not.toBeNull();

    const round = (await roundPromise) as Awaited<
      ReturnType<typeof runProcessorRound>
    >;
    expect(round.status).toBe("success");
    expect(round.deletedInbox.length).toBe(1);
    expect(await listPendingInbox(vault.layout)).toEqual([]);
    expect(
      await pathExists(
        path.join(vault.root, vault.layout.diaryDir, "2026", "2026-07", "2026-07-29.md"),
      ),
    ).toBe(true);
  });

  it("唤醒与并发编排被单实例锁串行，不双开两轮", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const lock = createMemoryLock();
    const { workspace, captureHead } = await createFakeVaultAccess(vault.layout);
    const clock = fixedClock();

    // seed one inbox so a round has work
    const { seedInbox } = await import("../testkit/temp-vault.js");
    await seedInbox(vault.layout, "并发测试");
    await captureHead();

    let concurrent = 0;
    let maxConcurrent = 0;
    const slowAgent: AgentRunner = {
      async run(ctx) {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 80));
        const inbox = ctx.pendingInbox[0]!;
        await writeDiary(ctx.layout, "2026/2026-07/2026-07-29.md", "x\n");
        const { writeReceipt } = await import("../vault/fs.js");
        await writeReceipt(ctx.layout, {
          ok: true,
          round_id: ctx.roundId,
          round_ended_at: clock.now().toISOString(),
          processed: [
            {
              inbox,
              status: "done",
              diary: `${ctx.layout.diaryDir}/2026/2026-07/2026-07-29.md`,
            },
          ],
          failed: [],
          quarantine: [],
        });
        concurrent -= 1;
      },
    };

    const run = () =>
      runProcessorRound({
        options: vault.options,
        workspace,
        lock,
        agent: slowAgent,
        clock,
      });

    const [a, b] = await Promise.all([run(), run()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain("locked");
    expect(statuses.some((s) => s === "success" || s === "empty")).toBe(true);
    expect(maxConcurrent).toBe(1);
  });
});
