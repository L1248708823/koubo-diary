import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { acceptRound } from "./accept.js";
import { createTempVault, seedInbox, type TempVault } from "../testkit/temp-vault.js";
import { writeReceipt } from "../vault/fs.js";

describe("processor acceptance", () => {
  const vaults: TempVault[] = [];
  const roundId = "round-accept-test";

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("拒绝回执声明日记树内的想法路径", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "测试嵌套想法路径");
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const nestedIdea = `${vault.layout.diaryDir}/2026/2026-07/Yan帳/想法/嵌套.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, nestedIdea)), { recursive: true });
    await writeFile(path.join(vault.root, nestedIdea), "# 错误路径\n", "utf8");
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [
        {
          inbox,
          status: "done",
          diary,
          idea: nestedIdea,
        },
      ],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [{ path: diary, status: "A" }],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("idea 路径");
    }
  });

  it("拒绝日记引用不存在的研究简报", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "不能提前引用研究简报");
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(
      path.join(vault.root, diary),
      `# 日记\n\n研究简报：[[${vault.layout.researchDir}/尚未生成]]\n`,
      "utf8",
    );
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox, status: "done", diary }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [{ path: diary, status: "M" }],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("研究简报不存在");
    }
  });

  it("不因无关历史变更中的研究死链阻塞本轮", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "只验证当前日记");
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const historicalDiary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 当前日记\n", "utf8");
    await writeFile(
      path.join(vault.root, historicalDiary),
      `历史死链：[[${vault.layout.researchDir}/不存在]]\n`,
      "utf8",
    );
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox, status: "done", diary }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [
        { path: diary, status: "M" },
        { path: historicalDiary, status: "M" },
      ],
      roundId,
    });

    expect(result.ok).toBe(true);
  });

  it("拒绝同一 inbox 在回执中重复出现", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "重复回执");
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [
        { inbox, status: "done", diary },
        { inbox, status: "done", diary },
      ],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("重复交代");
    }
  });

  it("拒绝不同 inbox 复用同一个 idea 文件", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const firstInbox = await seedInbox(vault.layout, "第一条想法", {
      id: "20260730-220000-first01",
    });
    const secondInbox = await seedInbox(vault.layout, "第二条想法", {
      id: "20260730-220001-second1",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [
        {
          inbox: firstInbox,
          status: "done",
          diary,
          idea: "Yan帳/想法/共享.md",
        },
        {
          inbox: secondInbox,
          status: "done",
          diary,
          idea: "Yan帳/想法/共享.md",
        },
      ],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [firstInbox, secondInbox],
      changes: [],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("重复使用 idea");
    }
  });

  it("拒绝回执处理本轮快照外的 inbox", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const snapshotInbox = await seedInbox(vault.layout, "本轮条目", {
      id: "20260730-220000-round01",
    });
    const outsideInbox = await seedInbox(vault.layout, "范围外条目", {
      id: "20260730-220001-outside",
    });
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [],
      failed: [
        {
          inbox: outsideInbox,
          status: "failed",
          error: "不应处理",
        },
      ],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [snapshotInbox],
      changes: [],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("本轮快照");
    }
  });

  it("拒绝 agent 修改 inbox 内容", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "不可修改");
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [],
      failed: [{ inbox, status: "failed", error: "保留原文" }],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [{ path: inbox, status: "M" }],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("不得修改 inbox");
    }
  });

  it("拒绝缺少 round_id 的旧回执", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const inbox = await seedInbox(vault.layout, "缺少轮次身份");
    await writeFile(
      path.join(vault.root, vault.layout.processorDir, "last-run.json"),
      JSON.stringify({
        ok: true,
        round_ended_at: "2026-07-30T22:00:00+08:00",
        processed: [],
        failed: [{ inbox, status: "failed", error: "旧格式" }],
        quarantine: [],
      }),
      "utf8",
    );

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("回执 JSON 结构不合法");
    }
  });
});
