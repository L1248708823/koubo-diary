import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runResearchStage } from "./stage.js";
import {
  createResearchBriefRunner,
  type ResearchEvidenceBundle,
  type ResearchSourceAdapter,
} from "./brief.js";
import {
  createTempVault,
  fixedClock,
  type TempVault,
} from "../testkit/temp-vault.js";
import {
  createResearchTask,
  readResearchTasks,
  writeResearchTasks,
} from "./tasks.js";

describe("research brief write-back", () => {
  const vaults: TempVault[] = [];

  afterEach(async () => {
    while (vaults.length) {
      const vault = vaults.pop();
      if (vault) await vault.cleanup();
    }
  });

  it("用假来源为视频分析任务写回带证据和双链的顶层简报", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const clock = fixedClock("2026-08-01T12:00:00+08:00");
    const diary = `${vault.layout.diaryDir}/2026/2026-08/2026-08-01.md`;
    const idea = `${vault.layout.ideasDir}/三大项视频分析.md`;
    await writeSourceNote(vault, diary);
    await writeSourceNote(vault, idea);

    await writeResearchTasks(vault.layout, [
      createResearchTask({
        taskId: "task-video-analysis",
        sourceDiary: diary,
        sourceIdea: idea,
        question: "三大项视频分析能否支持个人技术验证？",
        now: clock.now().toISOString(),
      }),
    ]);

    const adapter: ResearchSourceAdapter = {
      async collect() {
        return videoAnalysisEvidence();
      },
    };

    const result = await runResearchStage({
      layout: vault.layout,
      maxResearchPerRound: 5,
      runner: createResearchBriefRunner(adapter),
      clock,
    });

    const tasks = await readResearchTasks(vault.layout);
    const brief = tasks[0]?.brief;
    expect(result).toMatchObject({ processed: 1, pending: 0, progressed: true });
    expect(tasks[0]?.status).toBe("complete");
    expect(brief).toMatch(/^Yan帳\/研究\/[^/]+\.md$/);

    const briefBody = await readFile(path.join(vault.root, brief!), "utf8");
    expect(briefBody).toContain("research_status: complete");
    expect(briefBody).toContain("## Research question");
    expect(briefBody).toContain("## Executive summary");
    expect(briefBody).toContain("## Evidence and facts");
    expect(briefBody).toContain("## Perspectives and red-team review");
    expect(briefBody).toContain("## Unknowns and limitations");
    expect(briefBody).toContain("## Scope and method");
    expect(briefBody).toContain("## Sources");
    expect(briefBody).toContain("https://example.com/pose-original");
    expect(briefBody).toContain("无法核验");
    expect(briefBody).toContain(`[[${diary.replace(/\.md$/, "")}]]`);
    expect(briefBody).toContain(`[[${idea.replace(/\.md$/, "")}]]`);
    expect(briefBody).toContain("医学诊断");
    expect(briefBody).toContain("变量");
    expect(briefBody).toContain("指标");

    const diaryBody = await readFile(path.join(vault.root, diary), "utf8");
    const ideaBody = await readFile(path.join(vault.root, idea), "utf8");
    const briefLink = `[[${brief!.replace(/\.md$/, "")}]]`;
    for (const sourceBody of [diaryBody, ideaBody]) {
      expect(sourceBody).toContain("needs_research: false");
      expect(sourceBody).toContain("research_status: complete");
      expect(sourceBody).toContain(briefLink);
    }

    const researchEntries = await readdir(
      path.join(vault.root, vault.layout.researchDir),
      { withFileTypes: true },
    );
    expect(researchEntries.filter((entry) => entry.isFile())).toHaveLength(1);
    expect(researchEntries.every((entry) => entry.isFile())).toBe(true);
  });

  it("同一来源和问题刷新时复用原简报并记录证据差异", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const clock = fixedClock("2026-08-01T12:00:00+08:00");
    const diary = `${vault.layout.diaryDir}/2026/2026-08/2026-08-01.md`;
    await writeSourceNote(vault, diary);
    const task = createResearchTask({
      taskId: "task-refresh",
      sourceDiary: diary,
      question: "如何验证视频分析方案？",
      now: clock.now().toISOString(),
    });
    await writeResearchTasks(vault.layout, [task]);

    const first = await runResearchStage({
      layout: vault.layout,
      maxResearchPerRound: 5,
      runner: createResearchBriefRunner({
        async collect() {
          return videoAnalysisEvidence({
            title: "视频分析方案验证",
            question: task.question,
          });
        },
      }),
      clock,
    });
    expect(first.pending).toBe(0);
    const firstTask = (await readResearchTasks(vault.layout))[0]!;
    const originalBrief = firstTask.brief!;
    await writeSourceNote(vault, diary, true);
    await writeResearchTasks(vault.layout, [
      {
        ...firstTask,
        status: "pending",
        updated_at: "2026-08-01T13:00:00.000Z",
      },
    ]);

    await runResearchStage({
      layout: vault.layout,
      maxResearchPerRound: 5,
      runner: createResearchBriefRunner({
        async collect() {
          return videoAnalysisEvidence({
            title: "视频分析方案验证",
            question: task.question,
            evidenceChanges: ["新增独立来源，确认动作指标需要稳定视角。"],
          });
        },
      }),
      clock,
    });

    const refreshedTask = (await readResearchTasks(vault.layout))[0]!;
    expect(refreshedTask.brief).toBe(originalBrief);
    const refreshedBody = await readFile(
      path.join(vault.root, originalBrief),
      "utf8",
    );
    expect(refreshedBody).toContain("## Evidence changes");
    expect(refreshedBody).toContain("新增独立来源，确认动作指标需要稳定视角。");
    expect(
      (await readFile(path.join(vault.root, diary), "utf8")).match(
        new RegExp(escapeRegExp(`[[${originalBrief.replace(/\.md$/, "")}]]`), "g"),
      ),
    ).toHaveLength(1);
    expect(
      (await readdir(path.join(vault.root, vault.layout.researchDir))).filter(
        (entry) => entry.endsWith(".md"),
      ),
    ).toHaveLength(1);
  });

  it("证据不足时保留研究候选和 needs_research", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const clock = fixedClock("2026-08-01T12:00:00+08:00");
    const diary = `${vault.layout.diaryDir}/2026/2026-08/2026-08-01.md`;
    await writeSourceNote(vault, diary);
    await writeResearchTasks(vault.layout, [
      createResearchTask({
        taskId: "task-insufficient",
        sourceDiary: diary,
        question: "目前没有足够资料回答什么？",
        now: clock.now().toISOString(),
      }),
    ]);

    const result = await runResearchStage({
      layout: vault.layout,
      maxResearchPerRound: 5,
      runner: createResearchBriefRunner({
        async collect() {
          return {
            ...videoAnalysisEvidence(),
            question: "目前没有足够资料回答什么？",
            facts: [],
            perspectives: [],
            sources: [],
            unknowns: ["当前没有可核验来源。"],
          };
        },
      }),
      clock,
    });

    const savedTask = (await readResearchTasks(vault.layout))[0]!;
    expect(result.processed).toBe(1);
    expect(savedTask.status).toBe("partial");
    expect(savedTask.last_error).toContain("证据");
    expect(await readFile(path.join(vault.root, diary), "utf8")).toContain(
      "needs_research: true",
    );
    expect(
      (await readdir(path.join(vault.root, vault.layout.researchDir))).filter(
        (entry) => entry.endsWith(".md"),
      ),
    ).toHaveLength(0);
  });

  it("已有 brief 属于其他任务时不覆盖原文件", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const clock = fixedClock("2026-08-01T12:00:00+08:00");
    const diary = `${vault.layout.diaryDir}/2026/2026-08/2026-08-01.md`;
    const existingBrief = `${vault.layout.researchDir}/已有简报.md`;
    await writeSourceNote(vault, diary);
    await mkdir(path.join(vault.root, vault.layout.researchDir), {
      recursive: true,
    });
    const originalBody = [
      "---",
      "type: research-brief",
      "task_id: other-task",
      "research_status: complete",
      "question: \"另一个问题\"",
      "source_diary: \"[[生活/日子一天天过去/2026/2026-07/2026-07-31]]\"",
      "---",
      "",
      "# 原有简报",
      "",
    ].join("\n");
    await writeFile(
      path.join(vault.root, existingBrief),
      originalBody,
      "utf8",
    );

    const task = {
      ...createResearchTask({
        taskId: "task-cannot-overwrite",
        sourceDiary: diary,
        question: "当前任务的问题",
        now: clock.now().toISOString(),
      }),
      brief: existingBrief,
    };
    await writeResearchTasks(vault.layout, [task]);

    const result = await runResearchStage({
      layout: vault.layout,
      maxResearchPerRound: 5,
      runner: createResearchBriefRunner({
        async collect() {
          return videoAnalysisEvidence({ question: task.question });
        },
      }),
      clock,
    });

    expect(result.processed).toBe(1);
    expect((await readResearchTasks(vault.layout))[0]?.status).toBe("blocked");
    expect(await readFile(path.join(vault.root, existingBrief), "utf8")).toBe(
      originalBody,
    );
    expect(await readFile(path.join(vault.root, diary), "utf8")).toContain(
      "needs_research: true",
    );
  });

  it("runner 虚报 complete 时由处理阶段拒绝不完整写回", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const clock = fixedClock("2026-08-01T12:00:00+08:00");
    const diary = `${vault.layout.diaryDir}/2026/2026-08/2026-08-01.md`;
    const brief = `${vault.layout.researchDir}/不完整简报.md`;
    await writeSourceNote(vault, diary);
    await writeResearchTasks(vault.layout, [
      createResearchTask({
        taskId: "task-invalid-complete",
        sourceDiary: diary,
        question: "如何验收研究写回？",
        now: clock.now().toISOString(),
      }),
    ]);

    const result = await runResearchStage({
      layout: vault.layout,
      maxResearchPerRound: 5,
      runner: {
        async run({ layout }) {
          await mkdir(path.join(layout.vaultPath, layout.researchDir), {
            recursive: true,
          });
          await writeFile(path.join(layout.vaultPath, brief), "# 不完整\n", "utf8");
          return { status: "complete" as const, brief };
        },
      },
      clock,
    });

    const savedTask = (await readResearchTasks(vault.layout))[0]!;
    expect(result.processed).toBe(1);
    expect(savedTask.status).toBe("partial");
    expect(savedTask.last_error).toContain("research-brief");
    expect(await readFile(path.join(vault.root, diary), "utf8")).toContain(
      "needs_research: true",
    );
  });
});

async function writeSourceNote(
  vault: TempVault,
  relativePath: string,
  needsResearch = true,
): Promise<void> {
  const absolutePath = path.join(vault.root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    [
      "---",
      `needs_research: ${needsResearch}`,
      `research_status: ${needsResearch ? "pending" : "complete"}`,
      "---",
      "",
      "三大项视频分析需要先验证技术边界。",
      "",
    ].join("\n"),
    "utf8",
  );
}

function videoAnalysisEvidence(
  overrides: Partial<ResearchEvidenceBundle> = {},
): ResearchEvidenceBundle {
  return {
    title: "三大项视频分析的最小可行验证",
    question: "三大项视频分析能否支持个人技术验证？",
    executiveSummary:
      "固定机位、可见杠铃和足够清晰的视频可以支持动作指标的初步验证，但不能仅凭视频完成伤病诊断。",
    facts: [
      {
        claim: "姿态估计可以从视频中提取关节位置等可观察指标。",
        evidence: "姿态模型输出的是图像中的关键点和置信度。",
        sourceIds: ["pose-original", "pose-independent"],
      },
      {
        claim: "视频中的动作异常不等于医学诊断。",
        evidence: "动作观察与病因判断需要不同证据和专业判断。",
        sourceIds: ["health-counter"],
      },
    ],
    inferences: [
      "个人最小验证应先固定拍摄条件，再比较动作指标的一致性。",
    ],
    recommendations: [
      "先验证动作分段、关键点稳定性和人工标注一致性，不把输出命名为伤病判断。",
    ],
    perspectives: [
      {
        label: "工程可行性",
        viewpoint: "动作指标可以作为原型阶段的可观察输出。",
        sourceIds: ["pose-original", "pose-independent"],
        redTeam: false,
      },
      {
        label: "反方审查",
        viewpoint: "遮挡、视角变化和个体差异可能让稳定性下降，医学解释仍需专业人员。",
        sourceIds: ["health-counter"],
        redTeam: true,
      },
    ],
    unknowns: ["不同负重、镜头和动作速度下的个人误差尚未测量。"],
    limitations: ["假来源只用于确定性测试，不能证明真实研究结论。"],
    method: [
      "先使用原始技术资料，再使用独立资料交叉确认，最后检查健康边界和反方条件。",
    ],
    stopReason: "新增来源不再改变主要结论、证据强度和未知点。",
    sources: [
      {
        id: "pose-original",
        kind: "original",
        title: "Pose estimation for human movement",
        authorOrInstitution: "International Movement Lab",
        publishedAt: "2024-02-01",
        accessedAt: "2026-08-01",
        url: "https://example.com/pose-original",
        scope: "二维视频中的可观察姿态指标",
        limitations: "不覆盖个体医学诊断",
        evidence: "公开技术资料描述关键点和置信度输出。",
        verified: true,
      },
      {
        id: "pose-independent",
        kind: "independent",
        title: "Independent review of pose tracking",
        authorOrInstitution: "Independent Computer Vision Group",
        publishedAt: "2024-05-10",
        accessedAt: "2026-08-01",
        url: "https://example.com/pose-independent",
        scope: "不同视角下的姿态追踪限制",
        limitations: "样本条件与个人训练场景不同",
        evidence: "独立资料讨论遮挡和视角对稳定性的影响。",
        verified: true,
      },
      {
        id: "health-counter",
        kind: "counter",
        title: "Clinical boundary for movement observation",
        authorOrInstitution: "International Sports Medicine Board",
        publishedAt: "2023-09-20",
        accessedAt: "2026-08-01",
        url: "https://example.com/health-counter",
        scope: "动作观察与医学判断的边界",
        limitations: "不能替代面对面专业评估",
        evidence: "反方资料要求将观察性指标与诊断结论分开。",
        verified: true,
      },
      {
        id: "unverified-tip",
        kind: "counter",
        title: "训练者论坛经验",
        authorOrInstitution: "",
        publishedAt: "",
        accessedAt: "",
        scope: "无法核验的个人经验",
        limitations: "页面无法打开，不能支撑关键结论",
        evidence: "仅作为待验证线索。",
        verified: false,
      },
    ],
    followUpIdeas: [
      "个人验证路线：固定机位，控制视角、负重和动作速度等变量，比较关键点稳定性与人工标注一致性等指标。",
    ],
    ...overrides,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
