import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { pathExists } from "../vault/fs.js";
import path from "node:path";
import {
  createTempVault,
  createMemoryLock,
  createFakeVaultAccess,
  createFakeAgent,
  fixedClock,
  seedInbox,
  writeDiary,
  type TempVault,
} from "../testkit/temp-vault.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import { writeReceipt } from "../vault/fs.js";
import type { AgentContext, AgentRunner } from "../types.js";

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
    const { workspace, captureHead } = await createFakeVaultAccess(vault.layout);
    const clock = fixedClock();
    return { vault, lock, workspace, captureHead, clock };
  }

  it("空收件箱运行一轮：早退、不调用 agent", async () => {
    const { vault, lock, workspace, clock } = await setup();
    let agentCalls = 0;
    const agent: AgentRunner = {
      async run() {
        agentCalls += 1;
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("empty");
    expect(result.agentInvoked).toBe(false);
    expect(agentCalls).toBe(0);
  });

  it("假 agent 对一条 inbox 声明 done 且日记存在：验收后删除 inbox，写回仍在", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "今天想通了一件事");
    await captureHead();

    const diaryRel = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      expect(pendingInbox).toContain(inboxRel);
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "## 12:00\n\n今天想通了一件事\n");
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
      workspace,
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
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "缺日记的一条");
    await captureHead();

    const agent = createFakeAgent(async () => ({
      ok: true,
      round_ended_at: "2026-07-29T12:05:00+08:00",
      processed: [
        {
          inbox: inboxRel,
          status: "done",
          diary: `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`,
        },
      ],
      failed: [],
      quarantine: [],
    }));

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(result.deletedInbox).toEqual([]);
  });

  it("agent 回写旧 round_id：整轮失败且保留 inbox", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "拒绝旧回执");
    await captureHead();

    let receivedRoundId = "";
    const agent: AgentRunner = {
      async run(ctx) {
        receivedRoundId = (ctx as AgentContext & { roundId?: string }).roundId ?? "";
        const diary = await writeDiary(
          ctx.layout,
          "2026/2026-07/2026-07-29.md",
          "旧回执测试\n",
        );
        await writeReceipt(ctx.layout, {
          ok: true,
          round_id: "stale-round",
          round_ended_at: "2026-07-29T12:05:00+08:00",
          processed: [{ inbox: inboxRel, status: "done", diary }],
          failed: [],
          quarantine: [],
        });
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(receivedRoundId).not.toBe("");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("round_id");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
  });

  it("旧 round_id 与越权写回同时出现：仍清理越权文件", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "旧回执越权组合");
    await captureHead();
    const nestedIdea = `${vault.layout.diaryDir}/2026/2026-07/Yan帳/想法/旧回执越权.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await mkdir(path.dirname(path.join(layout.vaultPath, nestedIdea)), {
        recursive: true,
      });
      await writeFile(
        path.join(layout.vaultPath, nestedIdea),
        "# 旧回执不应留下的文件\n",
        "utf8",
      );
      const diary = await writeDiary(
        layout,
        "2026/2026-07/2026-07-29.md",
        "旧回执组合测试\n",
      );
      return {
        ok: true,
        round_id: "stale-round",
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [{ inbox: pendingInbox[0]!, status: "done", diary }],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("白名单外路径");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(await pathExists(path.join(vault.root, nestedIdea))).toBe(false);
  });

  it("agent 新建嵌套 Yan帳 文件：整轮失败并清理越权文件", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "拒绝嵌套目录");
    await captureHead();
    const nestedIdea = `${vault.layout.diaryDir}/2026/2026-07/Yan帳/想法/越权.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await mkdir(path.dirname(path.join(layout.vaultPath, nestedIdea)), {
        recursive: true,
      });
      await writeFile(
        path.join(layout.vaultPath, nestedIdea),
        "# 不应写入\n",
        "utf8",
      );
      const diary = await writeDiary(
        layout,
        "2026/2026-07/2026-07-29.md",
        "嵌套目录测试\n",
      );
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [{ inbox: pendingInbox[0]!, status: "done", diary }],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("白名单外路径");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(await pathExists(path.join(vault.root, nestedIdea))).toBe(false);
  });

  it("agent 写入隔离区：整轮失败并清理越权文件", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "隔离区只允许脚本管理");
    await captureHead();
    const quarantineFile = `${vault.layout.quarantineDir}/越权.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeFile(
        path.join(layout.vaultPath, quarantineFile),
        "# 不应写入隔离区\n",
        "utf8",
      );
      const diary = await writeDiary(
        layout,
        "2026/2026-07/2026-07-29.md",
        "隔离区测试\n",
      );
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [{ inbox: pendingInbox[0]!, status: "done", diary }],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(await pathExists(path.join(vault.root, quarantineFile))).toBe(false);
  });

  it("agent 修改 inbox 内容：恢复原文后再递增 attempts", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "必须保留的原始内容");
    await captureHead();

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeFile(
        path.join(layout.vaultPath, pendingInbox[0]!),
        "---\nattempts: 0\n---\n\nagent 篡改\n",
        "utf8",
      );
      return {
        ok: false,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [],
        failed: [{ inbox: pendingInbox[0]!, status: "failed", error: "拒绝修改" }],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    const restored = await readFile(path.join(vault.root, inboxRel), "utf8");
    expect(result.status).toBe("failed");
    expect(restored).toContain("必须保留的原始内容");
    expect(restored).not.toContain("agent 篡改");
    expect(restored).toContain("attempts: 1");
  });

  it("agent 重命名 inbox：恢复旧路径并清理新路径", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "不能移动的原文");
    await captureHead();
    const renamedInbox = `${vault.layout.inboxDir}/renamed.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await rename(
        path.join(layout.vaultPath, pendingInbox[0]!),
        path.join(layout.vaultPath, renamedInbox),
      );
      return {
        ok: false,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [],
        failed: [{ inbox: pendingInbox[0]!, status: "failed", error: "拒绝移动" }],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(await pathExists(path.join(vault.root, renamedInbox))).toBe(false);
  });

  it("工作树出现回执未授权的 inbox 删除：轮次失败，inbox 尽量恢复", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
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
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
  });

  it("失败累计至阈值：条目进入隔离区，后续普通待处理不再包含", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
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
      workspace,
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
      workspace,
      lock,
      agent: agent2,
      clock,
    });
    expect(result2.status).toBe("empty");
    expect(seenPending).toEqual([]);
  });

  it("收件箱超过单轮上限：本轮最多处理上限条", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
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
          "2026/2026-07/2026-07-29.md",
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
      workspace,
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
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const { controls } = await (async () => {
      // reuse git but we need controls — recreate bound to same layout
      return createFakeVaultAccess(vault.layout).then(async (g) => {
        // copy head from current tree
        await g.captureHead();
        return g;
      });
    })();
    // Actually the setup git is separate; inject extra change via a custom git wrapper.
    const inboxRel = await seedInbox(vault.layout, "白名单测试");
    await captureHead();

    const baseWorkspace = workspace;
    const wrappedWorkspace = {
      ...baseWorkspace,
      async listChanges() {
        const changes = await baseWorkspace.listChanges();
        return [...changes, { path: "secrets/token.txt", status: "A" }];
      },
    };

    const agent = createFakeAgent(async ({ layout }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "ok\n");
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          {
            inbox: inboxRel,
            status: "done",
            diary: `${layout.diaryDir}/2026/2026-07/2026-07-29.md`,
          },
        ],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace: wrappedWorkspace,
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
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const a = await seedInbox(vault.layout, "会申报", {
      id: "20260729-120000-acct01",
    });
    const b = await seedInbox(vault.layout, "被漏报", {
      id: "20260729-120000-miss01",
    });
    await captureHead();

    const agent = createFakeAgent(async ({ layout }) => {
      const diary = await writeDiary(layout, "2026/2026-07/2026-07-29.md", "## only a\n");
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
      workspace,
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
    const { vault, workspace, clock } = await setup();
    const lock = createMemoryLock(true);
    let agentCalls = 0;
    const agent: AgentRunner = {
      async run() {
        agentCalls += 1;
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("locked");
    expect(result.agentInvoked).toBe(false);
    expect(agentCalls).toBe(0);
  });
});
