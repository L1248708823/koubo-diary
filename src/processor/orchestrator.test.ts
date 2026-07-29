import { describe, it, expect, afterEach } from "vitest";
import { pathExists } from "../vault/fs.js";
import path from "node:path";
import {
  createTempVault,
  createMemoryLock,
  createFakeGit,
  createFakeAgent,
  fixedClock,
  seedInbox,
  writeDiary,
  type TempVault,
} from "../testkit/temp-vault.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import type { AgentRunner } from "../types.js";

describe("processor orchestrator (seam 1)", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const v = vaults.pop();
      if (v) await v.cleanup();
    }
  });

  async function setup() {
    const vault = await createTempVault();
    vaults.push(vault);
    const lock = createMemoryLock();
    const { git, captureHead } = await createFakeGit(vault.layout);
    const clock = fixedClock();
    return { vault, lock, git, captureHead, clock };
  }

  it("空收件箱运行一轮：早退、不调用 agent", async () => {
    const { vault, lock, git, clock } = await setup();
    let agentCalls = 0;
    const agent: AgentRunner = {
      async run() {
        agentCalls += 1;
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("empty");
    expect(result.agentInvoked).toBe(false);
    expect(agentCalls).toBe(0);
  });

  it("假 agent 对一条 inbox 声明 done 且日记存在：验收后删除 inbox，写回仍在", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "今天想通了一件事");
    await captureHead();

    const diaryRel = `${vault.layout.diaryDir}/2026-07-29.md`;
    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      expect(pendingInbox).toContain(inboxRel);
      await writeDiary(layout, "2026-07-29.md", "## 12:00\n\n今天想通了一件事\n");
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          {
            inbox: inboxRel,
            status: "done",
            diary: diaryRel,
          },
        ],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("success");
    expect(result.agentInvoked).toBe(true);
    expect(result.deletedInbox).toContain(inboxRel);
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(false);
    expect(await pathExists(path.join(vault.root, diaryRel))).toBe(true);
  });

  it("done 但缺 diary：验收失败，inbox 仍在", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "缺日记的一条");
    await captureHead();

    const agent = createFakeAgent(async () => ({
      ok: true,
      round_ended_at: "2026-07-29T12:05:00+08:00",
      processed: [
        {
          inbox: inboxRel,
          status: "done",
          diary: `${vault.layout.diaryDir}/2026-07-29.md`,
        },
      ],
      failed: [],
      quarantine: [],
    }));

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(result.deletedInbox).toEqual([]);
  });

  it("工作树出现回执未授权的 inbox 删除：轮次失败，inbox 尽量恢复", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "不该被 agent 删");
    await captureHead();

    const agent = createFakeAgent(async ({ layout }) => {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(layout.vaultPath, inboxRel), { force: true });
      // 回执假装 failed，并未授权删除
      return {
        ok: false,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [],
        failed: [
          {
            inbox: inboxRel,
            status: "failed",
            error: "model confused",
          },
        ],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
  });

  it("失败累计至阈值：条目进入隔离区，后续普通待处理不再包含", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "反复失败", { attempts: 2 });
    await captureHead();

    const agent = createFakeAgent(async () => ({
      ok: false,
      round_ended_at: "2026-07-29T12:05:00+08:00",
      processed: [],
      failed: [
        {
          inbox: inboxRel,
          status: "failed",
          error: "still bad",
          attempts_observed: 2,
        },
      ],
      quarantine: [],
    }));

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("success");
    expect(result.quarantined.some((p) => p.endsWith(path.basename(inboxRel)))).toBe(
      true,
    );
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(false);
    const qPath = path.join(
      vault.root,
      vault.layout.quarantineDir,
      path.basename(inboxRel),
    );
    expect(await pathExists(qPath)).toBe(true);

    // 再跑一轮：不应再把隔离区当普通待处理
    let seenPending: string[] = [];
    const agent2 = createFakeAgent(async ({ pendingInbox }) => {
      seenPending = pendingInbox;
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:10:00+08:00",
        processed: [],
        failed: [],
        quarantine: [],
      };
    });
    // 空了应早退；若还有其它 inbox 才调 agent。这里收件箱已空。
    const result2 = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent: agent2,
      clock,
    });
    expect(result2.status).toBe("empty");
    expect(seenPending).toEqual([]);
  });

  it("收件箱超过单轮上限：本轮最多处理上限条", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    vault.options.maxPerRound = 2;
    for (let i = 0; i < 4; i++) {
      await seedInbox(vault.layout, `条目 ${i}`, {
        id: `20260729-12000${i}-item${i}`,
      });
    }
    await captureHead();

    let received: string[] = [];
    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      received = pendingInbox;
      const processed = [];
      for (const inbox of pendingInbox) {
        const diary = await writeDiary(
          layout,
          "2026-07-29.md",
          `## note\n\n${inbox}\n`,
        );
        // append-style: rewrite ok for fake
        processed.push({
          inbox,
          status: "done" as const,
          diary,
        });
      }
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed,
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("success");
    expect(received.length).toBe(2);
    expect(result.deletedInbox.length).toBe(2);

    const { listPendingInbox } = await import("../vault/fs.js");
    const left = await listPendingInbox(vault.layout);
    expect(left.length).toBe(2);
  });

  it("白名单外路径出现变更：整轮失败", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    const { controls } = await (async () => {
      // reuse git but we need controls — recreate bound to same layout
      return createFakeGit(vault.layout).then(async (g) => {
        // copy head from current tree
        await g.captureHead();
        return g;
      });
    })();
    // Actually the setup git is separate; inject extra change via a custom git wrapper.
    const inboxRel = await seedInbox(vault.layout, "白名单测试");
    await captureHead();

    const baseGit = git;
    const wrappedGit = {
      ...baseGit,
      async listChanges() {
        const changes = await baseGit.listChanges();
        return [...changes, { path: "secrets/token.txt", status: "A" }];
      },
    };

    const agent = createFakeAgent(async ({ layout }) => {
      await writeDiary(layout, "2026-07-29.md", "ok\n");
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          {
            inbox: inboxRel,
            status: "done",
            diary: `${layout.diaryDir}/2026-07-29.md`,
          },
        ],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      git: wrappedGit,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/白名单|whitelist|未授权路径/i);
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    void controls;
  });

  it("回执漏报快照内条目：异常轮失败，不删任何 inbox", async () => {
    const { vault, lock, git, captureHead, clock } = await setup();
    const a = await seedInbox(vault.layout, "会申报", {
      id: "20260729-120000-acct01",
    });
    const b = await seedInbox(vault.layout, "被漏报", {
      id: "20260729-120000-miss01",
    });
    await captureHead();

    const agent = createFakeAgent(async ({ layout }) => {
      const diary = await writeDiary(layout, "2026-07-29.md", "## only a\n");
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [{ inbox: a, status: "done", diary }],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/未在回执交代/);
    expect(await pathExists(path.join(vault.root, a))).toBe(true);
    expect(await pathExists(path.join(vault.root, b))).toBe(true);
  });

  it("锁已被占用：立即退出，不启动 agent", async () => {
    const { vault, git, clock } = await setup();
    const lock = createMemoryLock(true);
    let agentCalls = 0;
    const agent: AgentRunner = {
      async run() {
        agentCalls += 1;
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      git,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("locked");
    expect(result.agentInvoked).toBe(false);
    expect(agentCalls).toBe(0);
  });
});
