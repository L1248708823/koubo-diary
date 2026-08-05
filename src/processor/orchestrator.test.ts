import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
  writeIdea,
  type TempVault,
} from "../testkit/temp-vault.js";
import { runProcessorRound } from "../processor/orchestrator.js";
import { writeReceipt } from "../vault/fs.js";
import {
  createResearchTask,
  readResearchTasks,
  writeResearchTasks,
} from "../research/tasks.js";
import {
  createResearchBriefRunner,
  type ResearchEvidenceBundle,
} from "../research/brief.js";
import type {
  AgentContext,
  AgentRunner,
  ResearchRunner,
  VaultPublisher,
} from "../types.js";

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

  it("收件箱读取错误时返回失败并保留原因，不调用 agent", async () => {
    const { vault, lock, workspace, clock } = await setup();
    const brokenInbox = path.join(vault.root, "broken-inbox");
    await writeFile(brokenInbox, "无法作为目录读取\n", "utf8");
    vault.options.layout.inboxDir = "broken-inbox";
    let agentCalls = 0;

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: {
        async run() {
          agentCalls += 1;
        },
      },
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/收件箱|目录|ENOTDIR|not a directory/i);
    expect(agentCalls).toBe(0);
  });

  it("工作区状态读取失败时停止验收并返回原因", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    await seedInbox(vault.layout, "工作区状态读取失败");
    await captureHead();
    const failingWorkspace = {
      ...workspace,
      async listChanges() {
        throw new Error("git status 读取失败");
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace: failingWorkspace,
      lock,
      agent: { async run() {} },
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("git status 读取失败");
  });

  it("STATE 写回失败时返回失败原因", async () => {
    const { vault, lock, workspace, clock } = await setup();
    await mkdir(
      path.join(vault.root, vault.options.layout.processorDir, "STATE.md"),
    );

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: { async run() {} },
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/STATE|EISDIR|目录/i);
  });

  it("失败路径发布失败时返回发布原因", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const lock = createMemoryLock();
    const { workspace, publisher, controls, captureHead } =
      await createFakeVaultAccess(vault.layout);
    const clock = fixedClock();
    const inboxRel = await seedInbox(vault.layout, "失败路径发布");
    await captureHead();
    controls.commitResult = {
      ok: false,
      reason: "失败路径 commit 失败",
      committed: false,
    };

    const agent = createFakeAgent(async ({ pendingInbox }) => ({
      ok: true,
      round_ended_at: "2026-07-29T12:05:00+08:00",
      processed: [
        {
          inbox: pendingInbox[0] ?? inboxRel,
          status: "done",
          diary: vault.layout.diaryDir + "/2026/2026-07/2026-07-29.md",
        },
      ],
      failed: [],
      quarantine: [],
    }));

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      publisher,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("失败路径 commit 失败");
  });

  it("研究任务状态读取失败时保留原始原因", async () => {
    const { vault, lock, workspace, clock } = await setup();
    await writeFile(
      path.join(vault.root, vault.layout.processorDir, "research-tasks.json"),
      JSON.stringify({ invalid: true }),
      "utf8",
    );

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: { async run() {} },
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("研究任务状态格式不合法");
  });

  it("内容 agent 写入非法研究任务状态时不删除收件项", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "研究状态格式错误");
    await captureHead();
    const diaryRel = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "日记写回\n");
      await writeFile(
        path.join(layout.vaultPath, layout.processorDir, "research-tasks.json"),
        JSON.stringify({ invalid: true }),
        "utf8",
      );
      return {
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: [{ inbox: pendingInbox[0]!, status: "done", diary: diaryRel }],
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
    expect(result.reason).toContain("研究任务状态格式不合法");
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(true);
    expect(
      await pathExists(
        path.join(vault.root, vault.layout.processorDir, "research-tasks.json"),
      ),
    ).toBe(false);
  });

  it("没有 research runner 时明确报告未完成研究", async () => {
    const { vault, lock, workspace, clock } = await setup();
    const diary = await writeDiary(
      vault.layout,
      "2026/2026-07/2026-07-29.md",
      "等待研究来源。\n",
    );
    await writeResearchTasks(vault.layout, [
      createResearchTask({
        taskId: "research-without-runner",
        sourceDiary: diary,
        question: "没有 runner 时是否仍需显示积压？",
        now: clock.now().toISOString(),
      }),
    ]);

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: { async run() {} },
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.researchPending).toBe(1);
    expect(result.reason).toContain("research runner");
  });

  it("研究 runner 的未知异常进入处理轮失败", async () => {
    const { vault, lock, workspace, clock } = await setup();
    const diary = await writeDiary(
      vault.layout,
      "2026/2026-07/2026-07-29.md",
      "研究 runner 异常。\n",
    );
    await writeResearchTasks(vault.layout, [
      createResearchTask({
        taskId: "research-runner-crash",
        sourceDiary: diary,
        question: "未知异常如何报告？",
        now: clock.now().toISOString(),
      }),
    ]);
    const researchRunner: ResearchRunner = {
      async run() {
        throw new Error("研究 runner 程序错误");
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: { async run() {} },
      researchRunner,
      clock,
    });
    const tasks = await readResearchTasks(vault.layout);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("研究 runner 程序错误");
    expect(tasks[0]?.status).toBe("running");
  });

  it("旧版研究任务缺少时间字段时，处理轮仍能进入研究阶段", async () => {
    const { vault, lock, workspace, clock } = await setup();
    const diary = await writeDiary(
      vault.layout,
      "2026/2026-07/2026-07-31.md",
      "需要继续验证的研究来源。\n",
    );
    await writeFile(
      path.join(vault.root, vault.layout.processorDir, "research-tasks.json"),
      JSON.stringify([
        {
          task_id: "legacy-orchestrator-task",
          source_diary: diary,
          question: "旧版任务能否继续进入研究阶段？",
          status: "pending",
        },
      ]),
      "utf8",
    );

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: { async run() {} },
      researchRunner: createResearchBriefRunner({
        async collect({ task }) {
          return integrationEvidence(task.question);
        },
      }),
      clock,
    });

    const tasks = await readResearchTasks(vault.layout);
    expect(result.status).toBe("success");
    expect(result.researchProcessed).toBe(1);
    expect(tasks[0]?.status).toBe("complete");
    expect(await pathExists(path.join(vault.root, tasks[0]?.brief ?? ""))).toBe(
      true,
    );
  });

  it("五条连续投递在一个处理环中唯一交代并进入研究阶段", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    vault.options.maxPerRound = 5;
    const inboxes: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      inboxes.push(
        await seedInbox(vault.layout, `连续口播 ${index + 1}`, {
          id: `20260729-12000${index}-bulk0${index}`,
        }),
      );
    }
    await captureHead();
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    const question = "五条连续口播对应的研究问题是什么？";

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(
        layout,
        "2026/2026-07/2026-07-29.md",
        pendingInbox.map((inbox) => `- 口播条目：${inbox}`).join("\n") + "\n",
      );
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-bulk-round",
          sourceDiary: diary,
          question,
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: pendingInbox.map((inbox) => ({
          inbox,
          status: "done" as const,
          diary,
        })),
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner: createResearchBriefRunner({
        async collect({ task }) {
          return integrationEvidence(task.question);
        },
      }),
      clock,
    });

    const receipt = JSON.parse(
      await readFile(path.join(vault.root, vault.layout.processorDir, "last-run.json"), "utf8"),
    ) as { processed: { inbox: string }[] };
    const tasks = await readResearchTasks(vault.layout);
    expect(result.status).toBe("success");
    expect(result.deletedInbox).toHaveLength(5);
    expect(new Set(receipt.processed.map((item) => item.inbox))).toEqual(
      new Set(inboxes),
    );
    expect(receipt.processed).toHaveLength(5);
    expect(result.researchProcessed).toBe(1);
    expect(tasks[0]?.status).toBe("complete");
    expect(
      await pathExists(path.join(vault.root, tasks[0]?.brief ?? "")),
    ).toBe(true);
    expect(
      await readFile(path.join(vault.root, diary), "utf8"),
    ).toContain("口播条目：_inbox/");
  });

  it("独立想法与待查轴同时成立，并从想法进入研究简报", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inbox = await seedInbox(vault.layout, "一个同时需要长期回看和核实的产品想法");
    await captureHead();
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    const idea = `${vault.layout.ideasDir}/2026-07-29-个人工具验证.md`;
    const question = "这个个人工具想法的最小验证路径是什么？";

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(
        layout,
        "2026/2026-07/2026-07-29.md",
        `## 12:00\n\n[[${idea.replace(/\.md$/, "")}]]\n${pendingInbox[0]}\n`,
      );
      await writeIdea(
        layout,
        "2026-07-29-个人工具验证.md",
        [
          "---",
          "needs_research: true",
          "research_status: pending",
          "---",
          "",
          `一个需要核实的产品想法。来源：[[${diary.replace(/\.md$/, "")}]]`,
          "",
        ].join("\n"),
      );
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-idea-round",
          sourceDiary: diary,
          sourceIdea: idea,
          question,
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: [{ inbox: pendingInbox[0]!, status: "done" as const, diary, idea }],
        failed: [],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner: createResearchBriefRunner({
        async collect({ task }) {
          return integrationEvidence(task.question);
        },
      }),
      clock,
    });

    const tasks = await readResearchTasks(vault.layout);
    const savedIdea = await readFile(path.join(vault.root, idea), "utf8");
    expect(result.status).toBe("success");
    expect(result.deletedInbox).toEqual([inbox]);
    expect(result.researchProcessed).toBe(1);
    expect(tasks[0]?.source_idea).toBe(idea);
    expect(tasks[0]?.status).toBe("complete");
    expect(savedIdea).toContain("needs_research: false");
    expect(savedIdea).toContain("research_status: complete");
    expect(savedIdea).toContain("[[Yan帳/研究/");
    expect(
      (await readdir(path.join(vault.root, vault.layout.researchDir))).filter(
        (entry) => entry.endsWith(".md"),
      ),
    ).toHaveLength(1);
  });

  it("内容整理验收后同轮运行 pending research，研究失败不回滚内容", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "需要核实的产品想法");
    await captureHead();
    const diaryRel = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    let researchCalls = 0;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "产品想法\n");
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-product-1",
          sourceDiary: diaryRel,
          question: "这个产品想法的可行性是什么？",
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          { inbox: pendingInbox[0]!, status: "done", diary: diaryRel },
        ],
        failed: [],
        quarantine: [],
      };
    });
    const researchRunner: ResearchRunner = {
      async run({ task }) {
        researchCalls += 1;
        expect(task.status).toBe("running");
        return { status: "partial", lastError: "证据仍然不足" };
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner,
      clock,
    });

    const tasks = await readResearchTasks(vault.layout);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("证据仍然不足");
    expect(result.researchProcessed).toBe(1);
    expect(researchCalls).toBe(1);
    expect(tasks[0]?.status).toBe("partial");
    const diaryBody = await readFile(path.join(vault.root, diaryRel), "utf8");
    expect(diaryBody).toContain("needs_research: true");
    expect(diaryBody).toContain("research_status: partial");
    expect(diaryBody).toContain("research_error: \"证据仍然不足\"");
    expect(await pathExists(path.join(vault.root, diaryRel))).toBe(true);
    expect(await pathExists(path.join(vault.root, inboxRel))).toBe(false);
  });

  it("研究任务 blocked 时不把轮次伪装成成功，并保留未完成数量", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "需要外部资料核实的一条");
    await captureHead();
    const diaryRel = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "研究状态测试\n");
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-blocked-state",
          sourceDiary: diaryRel,
          question: "这个问题暂时无法访问来源时怎么办？",
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          { inbox: pendingInbox[0]!, status: "done", diary: diaryRel },
        ],
        failed: [],
        quarantine: [],
      };
    });
    const researchRunner: ResearchRunner = {
      async run() {
        return { status: "blocked", lastError: "来源暂不可用" };
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner,
      clock,
    });

    const state = await readFile(
      path.join(vault.root, vault.layout.processorDir, "STATE.md"),
      "utf8",
    );
    const diaryBody = await readFile(path.join(vault.root, diaryRel), "utf8");
    const tasks = await readResearchTasks(vault.layout);
    expect(result.status).toBe("failed");
    expect(result.researchPending).toBe(1);
    expect(result.reason).toContain("来源暂不可用");
    expect(tasks[0]).toMatchObject({
      status: "blocked",
      last_error: "来源暂不可用",
    });
    expect(diaryBody).toContain("needs_research: true");
    expect(diaryBody).toContain("research_status: blocked");
    expect(diaryBody).toContain("research_error: \"来源暂不可用\"");
    expect(state).toContain("- status: failed");
    expect(state).toContain("- research_pending: 1");
    expect(state).toContain("来源暂不可用");
  });

  it("只有研究任务的轮次也会完成白名单检查并发布写回", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const lock = createMemoryLock();
    const { workspace, publisher, controls, captureHead } =
      await createFakeVaultAccess(vault.layout);
    const clock = fixedClock();
    const diaryRel = await writeDiary(
      vault.layout,
      "2026/2026-07/2026-07-29.md",
      "来源日记\n",
    );
    await writeResearchTasks(vault.layout, [
      createResearchTask({
        taskId: "research-only",
        sourceDiary: diaryRel,
        question: "需要核实的研究问题？",
        now: clock.now().toISOString(),
      }),
    ]);
    await captureHead();

    const researchRunner = createResearchBriefRunner({
      async collect({ task }) {
        return integrationEvidence(task.question);
      },
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      publisher,
      lock,
      agent: createFakeAgent(async () => ({
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: [],
        failed: [],
        quarantine: [],
      })),
      researchRunner,
      clock,
    });

    expect(result.status).toBe("success");
    expect(result.agentInvoked).toBe(false);
    const tasks = await readResearchTasks(vault.layout);
    expect(tasks[0]?.status).toBe("complete");
    expect(
      await pathExists(path.join(vault.root, tasks[0]?.brief ?? "")),
    ).toBe(true);
    expect(controls.head).toBe("HEAD-TEST-c");
  });

  it("处理环会在内容验收后完成假来源研究简报写回", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "需要研究的产品想法");
    await captureHead();
    const diaryRel = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "产品想法\n");
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-brief-round",
          sourceDiary: diaryRel,
          question: "这个产品想法的可行性是什么？",
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: [
          { inbox: pendingInbox[0]!, status: "done", diary: diaryRel },
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
      researchRunner: createResearchBriefRunner({
        async collect({ task }) {
          return integrationEvidence(task.question);
        },
      }),
      clock,
    });

    const tasks = await readResearchTasks(vault.layout);
    expect(result.status).toBe("success");
    expect(result.deletedInbox).toEqual([inboxRel]);
    expect(tasks[0]?.status).toBe("complete");
    expect(tasks[0]?.brief).toMatch(/^Yan帳\/研究\/[^/]+\.md$/);
    expect(
      await pathExists(path.join(vault.root, tasks[0]?.brief ?? "")),
    ).toBe(true);
    expect(await readFile(path.join(vault.root, diaryRel), "utf8")).toContain(
      "needs_research: false",
    );
  });

  it("把顶层想法和研究候选传给 agent，排除嵌套及无关路径", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    await writeIdea(vault.layout, "2026-07-29-已有想法.md", "已有想法\n");
    await mkdir(
      path.join(vault.root, vault.layout.ideasDir, "nested"),
      { recursive: true },
    );
    await writeFile(
      path.join(vault.root, vault.layout.ideasDir, "nested", "不应读取.md"),
      "嵌套想法\n",
      "utf8",
    );
    await writeFile(
      path.join(vault.root, vault.layout.researchDir, "已有研究.md"),
      "已有研究\n",
      "utf8",
    );
    await mkdir(
      path.join(vault.root, vault.layout.researchDir, "nested"),
      { recursive: true },
    );
    await writeFile(
      path.join(vault.root, vault.layout.researchDir, "nested", "不应读取.md"),
      "嵌套研究\n",
      "utf8",
    );
    const inbox = await seedInbox(vault.layout, "关联候选范围测试");
    await captureHead();
    const diary = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    let received: AgentContext | undefined;
    const agent: AgentRunner = {
      async run(ctx) {
        received = ctx;
        await writeDiary(vault.layout, "2026/2026-07/2026-07-29.md", "已处理\n");
        await writeReceipt(vault.layout, {
          ok: true,
          round_id: ctx.roundId,
          round_ended_at: clock.now().toISOString(),
          processed: [{ inbox, status: "done", diary }],
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

    expect(result.status).toBe("success");
    expect(received?.associationCandidates).toEqual({
      ideas: ["Yan帳/想法/2026-07-29-已有想法.md"],
      research: ["Yan帳/研究/已有研究.md"],
    });
  });

  it("研究 runner 修改 inbox 时失败并恢复脚本已保留的收件项", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const doneInbox = await seedInbox(vault.layout, "完成项", {
      id: "20260729-120000-done01",
    });
    const failedInbox = await seedInbox(vault.layout, "失败项", {
      id: "20260729-120000-fail01",
    });
    await captureHead();
    const diaryRel = await writeDiary(
      vault.layout,
      "2026/2026-07/2026-07-29.md",
      "内容整理\n",
    );
    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-inbox-safety",
          sourceDiary: diaryRel,
          question: "研究 runner 是否只读 inbox？",
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: [
          { inbox: doneInbox, status: "done", diary: diaryRel },
        ],
        failed: [
          { inbox: failedInbox, status: "failed", error: "稍后重试" },
        ],
        quarantine: [],
      };
    });
    const researchRunner: ResearchRunner = {
      async run({ vaultPath }) {
        await writeFile(path.join(vaultPath, failedInbox), "研究 runner 越权\n");
        return { status: "blocked", lastError: "测试越权" };
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner,
      clock,
    });

    const restored = await readFile(
      path.join(vault.root, failedInbox),
      "utf8",
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("不得修改 inbox");
    expect(restored).toContain("失败项");
    expect(restored).toContain("attempts: 1");
    expect(await pathExists(path.join(vault.root, doneInbox))).toBe(false);
  });

  it("处理期间新投递的 inbox 不会被验收恢复删除", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const firstInbox = await seedInbox(vault.layout, "第一条内容", {
      id: "20260729-120000-first01",
    });
    await captureHead();
    const secondInbox = `${vault.layout.inboxDir}/20260729-120001-second1.md`;
    const diaryRel = await writeDiary(
      vault.layout,
      "2026/2026-07/2026-07-29.md",
      "第一条内容\n",
    );
    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await seedInbox(layout, "第二条内容", {
        id: "20260729-120001-second1",
      });
      return {
        ok: true,
        round_ended_at: clock.now().toISOString(),
        processed: [
          { inbox: pendingInbox[0]!, status: "done", diary: diaryRel },
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
    expect(result.deletedInbox).toEqual([firstInbox]);
    expect(await pathExists(path.join(vault.root, secondInbox))).toBe(true);
  });

  it("研究任务按独立上限分批，收件箱为空时可继续研究阶段", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    vault.options.maxResearchPerRound = 1;
    const inboxRel = await seedInbox(vault.layout, "两个待查任务");
    await captureHead();
    const diaryRel = `${vault.layout.diaryDir}/2026/2026-07/2026-07-29.md`;
    const ideaRel = await writeIdea(vault.layout, "待查产品.md", "产品想法\n");
    const calls: string[] = [];

    const agent = createFakeAgent(async ({ layout, pendingInbox }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "两个待查任务\n");
      await writeResearchTasks(layout, [
        createResearchTask({
          taskId: "research-a",
          sourceDiary: diaryRel,
          question: "日记来源的问题？",
          now: clock.now().toISOString(),
        }),
        createResearchTask({
          taskId: "research-b",
          sourceIdea: ideaRel,
          question: "想法来源的问题？",
          now: clock.now().toISOString(),
        }),
      ]);
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          { inbox: pendingInbox[0]!, status: "done", diary: diaryRel },
        ],
        failed: [],
        quarantine: [],
      };
    });
    const researchRunner: ResearchRunner = {
      async run({ task }) {
        calls.push(task.task_id);
        return { status: "blocked", lastError: "来源暂不可用" };
      },
    };

    const first = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner,
      clock,
    });
    await captureHead();
    const second = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent,
      researchRunner,
      clock,
    });

    expect(first.status).toBe("failed");
    expect(first.researchProcessed).toBe(1);
    expect(first.researchPending).toBe(2);
    expect(second.status).toBe("failed");
    expect(second.agentInvoked).toBe(false);
    expect(second.researchProcessed).toBe(1);
    expect(second.researchPending).toBe(2);
    expect(calls).toEqual(["research-a", "research-b"]);
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

  it("白名单外路径恢复失败时保留恢复原因", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "恢复失败测试");
    await captureHead();
    let publishedPaths: string[] = [];
    const failingWorkspace = {
      ...workspace,
      async listChanges() {
        const changes = await workspace.listChanges();
        return [...changes, { path: "secrets/token.txt", status: "A" }];
      },
      async restore() {
        throw new Error("Git checkout 恢复失败");
      },
    };
    const agent = createFakeAgent(async ({ layout }) => {
      await writeDiary(layout, "2026/2026-07/2026-07-29.md", "恢复失败\\n");
      await writeFile(
        path.join(layout.vaultPath, inboxRel),
        "agent 修改了原始收件项\\n",
        "utf8",
      );
      return {
        ok: true,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [
          {
            inbox: inboxRel,
            status: "done",
            diary:
              layout.diaryDir + "/2026/2026-07/2026-07-29.md",
          },
        ],
        failed: [],
        quarantine: [],
      };
    });
    const publisher: VaultPublisher = {
      async publish(paths) {
        publishedPaths = paths;
        return { ok: true };
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace: failingWorkspace,
      publisher,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Git checkout 恢复失败");
    expect(publishedPaths).not.toContain(inboxRel);
  });

  it("收件项 attempts 读取失败时不静默继续", async () => {
    const { vault, lock, workspace, captureHead, clock } = await setup();
    const inboxRel = await seedInbox(vault.layout, "attempts 读取失败");
    await captureHead();
    const noOpRestoreWorkspace = {
      ...workspace,
      async restore() {},
    };
    const agent = createFakeAgent(async ({ layout }) => {
      const absolute = path.join(layout.vaultPath, inboxRel);
      await rename(absolute, absolute + ".moved");
      await mkdir(absolute);
      return {
        ok: false,
        round_ended_at: "2026-07-29T12:05:00+08:00",
        processed: [],
        failed: [{ inbox: inboxRel, status: "failed", error: "保留原文" }],
        quarantine: [],
      };
    });

    const result = await runProcessorRound({
      options: vault.options,
      workspace: noOpRestoreWorkspace,
      lock,
      agent,
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/attempts|EISDIR|目录/i);
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

  it("锁文件 I/O 失败时返回失败原因", async () => {
    const { vault, workspace, clock } = await setup();
    const lock = {
      async tryAcquire() {
        throw new Error("锁文件写入失败");
      },
    };

    const result = await runProcessorRound({
      options: vault.options,
      workspace,
      lock,
      agent: { async run() {} },
      clock,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("锁文件写入失败");
  });
});

function integrationEvidence(question: string): ResearchEvidenceBundle {
  return {
    title: "产品想法可行性研究",
    question,
    executiveSummary: "原型阶段可以验证核心流程，但仍需用真实样本确认边界。",
    facts: [
      {
        claim: "原型可以先验证可观察的技术指标。",
        evidence: "原始技术资料描述了可测量的输出。",
        sourceIds: ["original", "independent"],
      },
    ],
    inferences: ["先做小样本验证可以降低实现风险。"],
    recommendations: ["记录输入条件、输出指标和人工复核结果。"],
    perspectives: [
      {
        label: "支持观点",
        viewpoint: "固定条件下的原型验证具备可行性。",
        sourceIds: ["original"],
        redTeam: false,
      },
      {
        label: "反方审查",
        viewpoint: "样本偏差和环境变化可能削弱结论的外部有效性。",
        sourceIds: ["counter"],
        redTeam: true,
      },
    ],
    unknowns: ["真实用户样本下的误差范围尚未测量。"],
    limitations: ["假来源只验证写回契约，不证明真实研究结论。"],
    method: ["交叉检查原始资料、独立资料和反方条件。"],
    stopReason: "新增来源不再改变主要结论和未知点。",
    sources: [
      {
        id: "original",
        kind: "original",
        title: "Original technical material",
        authorOrInstitution: "Research Institute",
        publishedAt: "2024-01-01",
        accessedAt: "2026-08-01",
        url: "https://example.com/original",
        scope: "原型技术指标",
        limitations: "不覆盖真实用户样本",
        evidence: "原始资料说明了指标定义。",
        verified: true,
      },
      {
        id: "independent",
        kind: "independent",
        title: "Independent technical review",
        authorOrInstitution: "Independent Lab",
        publishedAt: "2024-02-01",
        accessedAt: "2026-08-01",
        url: "https://example.com/independent",
        scope: "独立复核",
        limitations: "实验条件有限",
        evidence: "独立资料指出了环境变量。",
        verified: true,
      },
      {
        id: "counter",
        kind: "counter",
        title: "Counter evidence review",
        authorOrInstitution: "Review Board",
        publishedAt: "2024-03-01",
        accessedAt: "2026-08-01",
        url: "https://example.com/counter",
        scope: "反方条件",
        limitations: "不适用于所有场景",
        evidence: "反方资料指出了外部有效性限制。",
        verified: true,
      },
    ],
  };
}
