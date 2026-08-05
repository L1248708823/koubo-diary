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

  it("允许一条 done 收件项声明多个独立想法", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "包含两个独立命题", {
      capturedAt: "2026-07-30T22:00:00+08:00",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const firstIdea = `${vault.layout.ideasDir}/2026-07-30-第一个命题.md`;
    const secondIdea = `${vault.layout.ideasDir}/2026-07-30-第二个命题.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.join(vault.root, vault.layout.ideasDir), { recursive: true });
    const ideaFrontmatter = [
      "---",
      "captured_at: 2026-07-30T22:00:00+08:00",
      `source_diary: [[${diary.replace(/\.md$/, "")}]]`,
      "---",
      "",
    ].join("\n");
    const diaryLink = `[[${diary.replace(/\.md$/, "")}]]`;
    await writeFile(
      path.join(vault.root, firstIdea),
      ideaFrontmatter + `${diaryLink}\n第一个想法\n`,
      "utf8",
    );
    await writeFile(
      path.join(vault.root, secondIdea),
      ideaFrontmatter + `${diaryLink}\n第二个想法\n`,
      "utf8",
    );
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [
        {
          inbox,
          status: "done",
          diary,
          ideas: [firstIdea, secondIdea],
        },
      ],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [
        { path: diary, status: "A" },
        { path: firstIdea, status: "A" },
        { path: secondIdea, status: "A" },
      ],
      roundId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.done[0]?.ideas).toEqual([firstIdea, secondIdea]);
  });

  it("拒绝新想法缺少当前日记回链或完整捕捉时间", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "想法回链契约", {
      capturedAt: "2026-07-30T22:00:00+08:00",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const idea = `${vault.layout.ideasDir}/2026-07-30-缺少回链.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, idea)), { recursive: true });
    await writeFile(
      path.join(vault.root, idea),
      "---\ncreated: 2026-07-30\n---\n\n想法正文\n",
      "utf8",
    );
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox, status: "done", diary, ideas: [idea] }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [
        { path: diary, status: "A" },
        { path: idea, status: "A" },
      ],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("idea 缺少");
  });

  it("拒绝只有 frontmatter 回链、正文没有当前日记回链的想法", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "正文回链契约", {
      capturedAt: "2026-07-30T22:00:00+08:00",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const idea = `${vault.layout.ideasDir}/2026-07-30-正文缺回链.md`;
    const diaryLink = `[[${diary.replace(/\.md$/, "")}]]`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, idea)), { recursive: true });
    await writeFile(
      path.join(vault.root, idea),
      [
        "---",
        "captured_at: 2026-07-30T22:00:00+08:00",
        `source_diary: ${diaryLink}`,
        "---",
        "",
        "想法正文没有来源回链。",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox, status: "done", diary, ideas: [idea] }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [
        { path: diary, status: "A" },
        { path: idea, status: "A" },
      ],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("idea 缺少");
  });

  it("拒绝新建想法文件使用错误的捕捉日期", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "日期命名校验", {
      capturedAt: "2026-07-30T22:00:00+08:00",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const idea = `${vault.layout.ideasDir}/2026-07-29-错误日期.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, idea)), { recursive: true });
    await writeFile(path.join(vault.root, idea), "想法\n", "utf8");
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox, status: "done", diary, ideas: [idea] }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [
        { path: diary, status: "A" },
        { path: idea, status: "A" },
      ],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("captured_at 日期");
  });

  it("拒绝新想法覆盖未列入既有候选的同名文件", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "想法文件冲突", {
      capturedAt: "2026-07-30T22:00:00+08:00",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const idea = `${vault.layout.ideasDir}/2026-07-30-冲突命题.md`;
    const diaryLink = `[[${diary.replace(/\.md$/, "")}]]`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, idea)), { recursive: true });
    await writeFile(
      path.join(vault.root, idea),
      [
        "---",
        "captured_at: 2026-07-30T22:00:00+08:00",
        `source_diary: ${diaryLink}`,
        "---",
        "",
        `${diaryLink}\n已有正文`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox, status: "done", diary, ideas: [idea] }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [inbox],
      changes: [
        { path: diary, status: "M" },
        { path: idea, status: "M" },
      ],
      existingIdeaPaths: [],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("idea 文件冲突");
      expect(result.recoveryPaths).toEqual([idea]);
    }
  });

  it("拒绝内容整理 agent 直接写入研究简报", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const inbox = await seedInbox(vault.layout, "不应由内容整理直接写研究");
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    const brief = `${vault.layout.researchDir}/不应提前写入.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await mkdir(path.dirname(path.join(vault.root, brief)), { recursive: true });
    await writeFile(path.join(vault.root, brief), "# 研究简报\n", "utf8");
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
        { path: diary, status: "A" },
        { path: brief, status: "A" },
      ],
      roundId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("不得写入研究目录");
  });

  it("允许处理轮次开始后新增的顶层 inbox", async () => {
    const vault = await createTempVault();
    vaults.push(vault);

    const snapshotInbox = await seedInbox(vault.layout, "本轮条目", {
      id: "20260730-220000-round01",
    });
    const arrivingInbox = await seedInbox(vault.layout, "处理期间新投递", {
      id: "20260730-220001-arrive1",
    });
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-30.md`;
    await mkdir(path.dirname(path.join(vault.root, diary)), { recursive: true });
    await writeFile(path.join(vault.root, diary), "# 日记\n", "utf8");
    await writeReceipt(vault.layout, {
      ok: true,
      round_id: roundId,
      round_ended_at: "2026-07-30T22:00:00+08:00",
      processed: [{ inbox: snapshotInbox, status: "done", diary }],
      failed: [],
      quarantine: [],
    });

    const result = await acceptRound({
      layout: vault.layout,
      snapshotInbox: [snapshotInbox],
      changes: [
        { path: diary, status: "A" },
        { path: arrivingInbox, status: "A" },
      ],
      roundId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.done.map((item) => item.inbox)).toEqual([snapshotInbox]);
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
