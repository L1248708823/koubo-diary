import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isDiaryPath,
  isIdeaPath,
  isResearchPath,
} from "../config.js";
import type {
  ResearchRunner,
  ResearchRunnerContext,
  ResearchRunnerResult,
  ResearchTask,
  VaultLayout,
} from "../types.js";
import { pathExists } from "../vault/fs.js";

/** 来源类型由问题决定，保留字符串以支持领域专用的来源分类。 */
export type ResearchSourceKind = string;

export type ResearchSource = {
  id: string;
  kind: ResearchSourceKind;
  title: string;
  authorOrInstitution: string;
  publishedAt: string;
  accessedAt: string;
  url?: string;
  scope: string;
  limitations: string;
  evidence: string;
  verified: boolean;
};

export type ResearchClaim = {
  claim: string;
  evidence: string;
  sourceIds: string[];
};

export type ResearchPerspective = {
  label: string;
  viewpoint: string;
  sourceIds: string[];
  redTeam: boolean;
};

export type ResearchEvidenceBundle = {
  title: string;
  question: string;
  executiveSummary: string;
  facts: ResearchClaim[];
  inferences: string[];
  recommendations: string[];
  perspectives: ResearchPerspective[];
  unknowns: string[];
  limitations: string[];
  method: string[];
  stopReason: string;
  sources: ResearchSource[];
  evidenceChanges?: string[];
  followUpIdeas?: string[];
};

export type ResearchSourceAdapter = {
  collect(ctx: ResearchRunnerContext): Promise<ResearchEvidenceBundle>;
};

type BriefTarget = {
  relativePath: string;
  previousBody?: string;
};

export class ResearchWritebackError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchWritebackError";
  }
}

export class ResearchReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchReadError";
  }
}

export function createResearchBriefRunner(
  adapter: ResearchSourceAdapter,
): ResearchRunner {
  return {
    async run(ctx): Promise<ResearchRunnerResult> {
      const sourcePathError = validateTaskSources(ctx.layout, ctx.task);
      if (sourcePathError) {
        return { status: "blocked", lastError: sourcePathError };
      }

      let bundle: ResearchEvidenceBundle;
      try {
        bundle = await adapter.collect(ctx);
      } catch (error) {
        const reason = `研究来源不可用: ${errorMessage(error)}`;
        await markResearchPending(ctx, "blocked", undefined, reason);
        return {
          status: "blocked",
          lastError: reason,
        };
      }

      const evidenceError = validateEvidenceBundle(ctx.task, bundle);
      if (evidenceError) {
        await markResearchPending(ctx, "partial", undefined, evidenceError);
        return { status: "partial", lastError: evidenceError };
      }

      let target: BriefTarget | undefined;
      let briefWritten = false;
      try {
        target = await resolveBriefTarget(ctx, bundle);
        const body = renderResearchBrief(ctx, bundle, target);
        await mkdir(path.join(ctx.vaultPath, ctx.layout.researchDir), {
          recursive: true,
        });
        await writeFile(
          path.join(ctx.vaultPath, target.relativePath),
          body,
          "utf8",
        );
        briefWritten = true;

        for (const sourcePath of sourcePaths(ctx.task)) {
          await updateSourceNote(
            ctx,
            sourcePath,
            target.relativePath,
            "complete",
            false,
          );
        }

        const writebackError = await validateResearchWriteback({
          layout: ctx.layout,
          task: ctx.task,
          briefPath: target.relativePath,
        });
        if (writebackError) {
          await markResearchBriefIncomplete({
            layout: ctx.layout,
            briefPath: target.relativePath,
            status: "partial",
          });
          await markResearchPending(
            ctx,
            "partial",
            target.relativePath,
            writebackError,
          );
          return {
            status: "partial",
            brief: target.relativePath,
            lastError: writebackError,
          };
        }
        return { status: "complete", brief: target.relativePath };
      } catch (error) {
        if (error instanceof ResearchReadError) throw error;
        const fallbackBrief =
          briefWritten && target ? target.relativePath : undefined;
        const reason = `研究简报写回失败: ${errorMessage(error)}`;
        if (briefWritten && target) {
          await markResearchBriefIncomplete({
            layout: ctx.layout,
            briefPath: target.relativePath,
            status: "blocked",
          });
        }
        await markResearchPending(ctx, "blocked", fallbackBrief, reason);
        return {
          status: "blocked",
          lastError: reason,
        };
      }
    },
  };
}

export async function validateResearchWriteback(args: {
  layout: VaultLayout;
  task: ResearchTask;
  briefPath: string;
}): Promise<string | undefined> {
  const { layout, task, briefPath } = args;
  if (!isResearchPath(briefPath, layout)) {
    return `研究简报路径不合法: ${briefPath}`;
  }
  if (task.source_diary && !isDiaryPath(task.source_diary, layout)) {
    return `研究来源日记路径不合法: ${task.source_diary}`;
  }
  if (task.source_idea && !isIdeaPath(task.source_idea, layout)) {
    return `研究来源想法路径不合法: ${task.source_idea}`;
  }
  if (sourcePaths(task).length === 0) {
    return "研究任务缺少来源日记或来源想法";
  }

  const briefAbsolutePath = path.join(layout.vaultPath, briefPath);
  let body: string;
  try {
    body = await readFile(briefAbsolutePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return `研究简报不存在: ${briefPath}`;
    throw new ResearchReadError(
      `研究简报读取失败: ${briefPath}: ${errorMessage(error)}`,
      error,
    );
  }

  const metadata = parseFrontmatter(body);
  if (metadata.type !== "research-brief") {
    return "研究简报缺少 type: research-brief";
  }
  if (metadata.task_id !== task.task_id) {
    return `研究简报 task_id 不匹配: ${briefPath}`;
  }
  if (metadata.research_status !== "complete") {
    return `研究简报状态未完成: ${briefPath}`;
  }
  if (!isDateOnly(metadata.created) || !isDateOnly(metadata.updated)) {
    return `研究简报缺少研究日期: ${briefPath}`;
  }
  if (metadata.question !== task.question.trim()) {
    return `研究简报 question 与任务不一致: ${briefPath}`;
  }
  if (
    task.source_diary &&
    metadata.source_diary !== sourceWikilink(task.source_diary)
  ) {
    return `研究简报缺少 source_diary 回链: ${briefPath}`;
  }
  if (
    task.source_idea &&
    metadata.source_idea !== sourceWikilink(task.source_idea)
  ) {
    return `研究简报缺少 source_idea 回链: ${briefPath}`;
  }
  const contentError = validateFlexibleBriefBody(body);
  if (contentError) return contentError;

  const briefLink = toWikilink(briefPath);
  for (const sourcePath of sourcePaths(task)) {
    const sourceAbsolutePath = path.join(layout.vaultPath, sourcePath);
    let sourceBody: string;
    try {
      sourceBody = await readFile(sourceAbsolutePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return `研究来源不存在: ${sourcePath}`;
      throw new ResearchReadError(
        `研究来源读取失败: ${sourcePath}: ${errorMessage(error)}`,
        error,
      );
    }
    if (!body.includes(toWikilink(sourcePath))) {
      return `研究简报缺少来源回链: ${sourcePath}`;
    }
    if (!sourceBody.includes(briefLink)) {
      return `研究来源缺少简报回链: ${sourcePath}`;
    }
    const sourceMetadata = parseFrontmatter(sourceBody);
    if (sourceMetadata.needs_research !== "false") {
      return `研究来源 needs_research 未关闭: ${sourcePath}`;
    }
    if (sourceMetadata.research_status !== "complete") {
      return `研究来源 research_status 未完成: ${sourcePath}`;
    }
    if (sourceMetadata.research_error !== undefined) {
      return `研究来源仍保留失败原因: ${sourcePath}`;
    }
  }
  for (const relatedBrief of task.related_briefs ?? []) {
    if (!isResearchPath(relatedBrief, layout)) {
      return `关联研究简报路径不合法: ${relatedBrief}`;
    }
    if (!(await pathExists(path.join(layout.vaultPath, relatedBrief)))) {
      return `关联研究简报不存在: ${relatedBrief}`;
    }
    if (!body.includes(toWikilink(relatedBrief))) {
      return `研究简报缺少关联研究回链: ${relatedBrief}`;
    }
  }
  return undefined;
}

const NOT_APPLICABLE_LINE =
  /^(本(?:节|部分|小节)?不适用|本(?:节|部分|小节)?不涉及|not applicable|n\/a)(?:[:：、。.，,\s]|$)/i;

function validateFlexibleBriefBody(body: string): string | undefined {
  const content = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  if (!/^#\s+\S/m.test(content)) {
    return "研究简报缺少标题";
  }

  const sections = parseMarkdownSections(content);
  const substantiveSections = sections.filter(
    (section) =>
      hasSectionContent([section]) && !isExplicitlyNotApplicable([section]),
  );
  if (substantiveSections.length < 2) {
    return "研究简报缺少实质内容";
  }

  const sourceSections = sections.filter((section) =>
    /(来源|资料|参考|出处|source|reference|provenance|bibliography)/i.test(
      section.heading,
    ),
  );
  if (isExplicitlyNotApplicable(sourceSections)) return undefined;
  const sourceContent = sourceSections.map((section) => section.body).join("\n");
  if (!hasSectionContent(sourceSections)) {
    return "研究简报缺少来源内容";
  }
  if (
    !/(https?:\/\/\S+|无法核验|不可核验|未找到可靠来源|source unavailable|unverifiable)/i.test(
      sourceContent,
    )
  ) {
    return "研究简报缺少可核验来源或不可核验说明";
  }
  return undefined;
}

/** 章节内容为显式的不适用声明时放行，避免模型为凑格式而填充。 */
function isExplicitlyNotApplicable(sections: MarkdownSection[]): boolean {
  return sections.some((section) =>
    section.body
      .split(/\r?\n/)
      .some((line) => NOT_APPLICABLE_LINE.test(line.trim())),
  );
}

type MarkdownSection = {
  level: number;
  heading: string;
  body: string;
};

function parseMarkdownSections(content: string): MarkdownSection[] {
  const headings = [
    ...content.matchAll(/^#{2,6}[ \t]+(.+?)[ \t]*(?:\r\n|\n|$)/gm),
  ];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const level = heading[0].match(/^#+/)?.[0].length ?? 2;
    const nextSection = headings
      .slice(index + 1)
      .find((candidate) => {
        const candidateLevel = candidate[0].match(/^#+/)?.[0].length ?? 2;
        return candidateLevel <= level;
      });
    const end = nextSection?.index ?? content.length;
    return {
      level,
      heading: heading[1]?.trim() ?? "",
      body: content.slice(start, end).trim(),
    };
  });
}

function hasSectionContent(sections: MarkdownSection[]): boolean {
  return sections.some((section) => section.body.length > 0);
}

export async function markResearchBriefIncomplete(args: {
  layout: VaultLayout;
  briefPath: string;
  status: "partial" | "blocked";
}): Promise<void> {
  const { layout, briefPath, status } = args;
  if (!isResearchPath(briefPath, layout)) {
    throw new Error(`研究简报路径不合法: ${briefPath}`);
  }
  const absolutePath = path.join(layout.vaultPath, briefPath);
  let body: string;
  try {
    body = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new ResearchWritebackError(
      `研究简报状态写回失败: ${briefPath}: ${errorMessage(error)}`,
      error,
    );
  }
  await writeFile(
    absolutePath,
    updateFrontmatter(body, { research_status: status }),
    "utf8",
  );
}

function validateEvidenceBundle(
  task: ResearchTask,
  bundle: ResearchEvidenceBundle,
): string | undefined {
  if (!bundle.title.trim() || !bundle.executiveSummary.trim()) {
    return "研究证据缺少标题或结论摘要";
  }
  if (bundle.question.trim() !== task.question.trim()) {
    return "研究简报问题必须保留任务的原始问题";
  }
  if (bundle.facts.length === 0) return "研究证据缺少事实与证据";
  if (bundle.method.length === 0 || !bundle.stopReason.trim()) {
    return "研究证据缺少研究方法或停止依据";
  }
  const sourceMap = new Map<string, ResearchSource>();
  for (const source of bundle.sources) {
    if (!source.id.trim() || sourceMap.has(source.id)) {
      return "研究来源 id 必须唯一且非空";
    }
    if (
      !source.title.trim() ||
      !source.scope.trim() ||
      !source.limitations.trim() ||
      !source.evidence.trim()
    ) {
      return `研究来源资料不完整: ${source.id}`;
    }
    if (source.verified && !isVerifiableSource(source)) {
      return `已核验研究来源缺少完整元数据: ${source.id}`;
    }
    sourceMap.set(source.id, source);
  }
  for (const claim of bundle.facts) {
    const error = validateSourceReferences(claim.sourceIds, sourceMap);
    if (error) return `事实证据 ${error}`;
    if (!claim.claim.trim() || !claim.evidence.trim()) {
      return "事实证据缺少 claim 或 evidence";
    }
  }
  for (const perspective of bundle.perspectives) {
    const error = validateSourceReferences(perspective.sourceIds, sourceMap);
    if (error) return `多视角证据 ${error}`;
    if (!perspective.label.trim() || !perspective.viewpoint.trim()) {
      return "多视角缺少名称或观点";
    }
  }
  return undefined;
}

function validateSourceReferences(
  sourceIds: string[],
  sourceMap: Map<string, ResearchSource>,
): string | undefined {
  if (sourceIds.length === 0) return "缺少来源引用";
  for (const sourceId of sourceIds) {
    if (!sourceMap.has(sourceId)) return `引用了不存在的来源: ${sourceId}`;
  }
  if (!sourceIds.some((sourceId) => sourceMap.get(sourceId)?.verified)) {
    return "关键内容缺少可核验来源";
  }
  return undefined;
}

function isVerifiableSource(source: ResearchSource): boolean {
  return (
    Boolean(source.url && /^https?:\/\/\S+$/i.test(source.url)) &&
    Boolean(source.authorOrInstitution.trim()) &&
    Boolean(source.publishedAt.trim()) &&
    Boolean(source.accessedAt.trim())
  );
}

async function resolveBriefTarget(
  ctx: ResearchRunnerContext,
  bundle: ResearchEvidenceBundle,
): Promise<BriefTarget> {
  if (ctx.task.brief !== undefined) {
    if (!isResearchPath(ctx.task.brief, ctx.layout)) {
      throw new Error(`任务中的 brief 路径不合法: ${ctx.task.brief}`);
    }
    if (await pathExists(path.join(ctx.vaultPath, ctx.task.brief))) {
      const previousBody = await readResearchFile(
        path.join(ctx.vaultPath, ctx.task.brief),
        ctx.task.brief,
      );
      if (!briefMatchesTask(previousBody, ctx.task)) {
        throw new Error(`任务中的 brief 已指向其他研究: ${ctx.task.brief}`);
      }
      return { relativePath: normalizePath(ctx.task.brief), previousBody };
    }
    return { relativePath: normalizePath(ctx.task.brief) };
  }

  const existing = await findExistingBrief(ctx);
  if (existing) return existing;

  const baseName = `${safeFilePart(bundle.title || ctx.task.question)}-${safeFilePart(ctx.task.task_id)}`;
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `-${index}`;
    const relativePath = `${ctx.layout.researchDir}/${baseName}${suffix}.md`;
    if (!(await pathExists(path.join(ctx.vaultPath, relativePath)))) {
      return { relativePath };
    }
    const previousBody = await readResearchFile(
      path.join(ctx.vaultPath, relativePath),
      relativePath,
    );
    if (briefMatchesTask(previousBody, ctx.task)) {
      return { relativePath, previousBody };
    }
    index += 1;
  }
}

async function findExistingBrief(
  ctx: ResearchRunnerContext,
): Promise<BriefTarget | undefined> {
  const relativePath = await findResearchBriefForTask(ctx.layout, ctx.task);
  if (!relativePath) return undefined;
  const body = await readResearchFile(
    path.join(ctx.vaultPath, relativePath),
    relativePath,
  );
  return { relativePath, previousBody: body };
}

export async function findResearchBriefForTask(
  layout: VaultLayout,
  task: ResearchTask,
): Promise<string | undefined> {
  if (
    task.brief &&
    isResearchPath(task.brief, layout) &&
    (await pathExists(path.join(layout.vaultPath, task.brief)))
  ) {
    const body = await readResearchFile(
      path.join(layout.vaultPath, task.brief),
      task.brief,
    );
    if (briefMatchesTask(body, task)) return normalizePath(task.brief);
  }

  const researchDir = path.join(layout.vaultPath, layout.researchDir);
  let entries;
  try {
    entries = await readdir(researchDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new ResearchReadError(
      `研究目录读取失败: ${researchDir}: ${errorMessage(error)}`,
      error,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const relativePath = `${layout.researchDir}/${entry.name}`;
    let body: string;
    try {
      body = await readResearchFile(
        path.join(layout.vaultPath, relativePath),
        relativePath,
      );
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    if (briefMatchesTask(body, task)) return relativePath;
  }
  return undefined;
}

function briefMatchesTask(body: string, task: ResearchTask): boolean {
  const metadata = parseFrontmatter(body);
  if (metadata.question !== task.question.trim()) return false;
  return (
    metadata.source_diary === sourceWikilink(task.source_diary) &&
    metadata.source_idea === sourceWikilink(task.source_idea)
  );
}

function validateTaskSources(
  layout: VaultLayout,
  task: ResearchTask,
): string | undefined {
  if (!task.source_diary && !task.source_idea) {
    return "研究任务缺少来源日记或来源想法";
  }
  if (task.source_diary && !isDiaryPath(task.source_diary, layout)) {
    return `研究来源日记路径不合法: ${task.source_diary}`;
  }
  if (task.source_idea && !isIdeaPath(task.source_idea, layout)) {
    return `研究来源想法路径不合法: ${task.source_idea}`;
  }
  return undefined;
}

function renderResearchBrief(
  ctx: ResearchRunnerContext,
  bundle: ResearchEvidenceBundle,
  target: BriefTarget,
): string {
  const lines = [
    "---",
    "type: research-brief",
    `task_id: ${yamlString(ctx.task.task_id)}`,
    "research_status: complete",
    `created: ${dateOnly(ctx.task.created_at)}`,
    `updated: ${dateOnly(ctx.now.toISOString())}`,
    `question: ${yamlString(bundle.question.trim())}`,
    ...(ctx.task.source_diary
      ? [`source_diary: ${yamlString(toWikilink(ctx.task.source_diary))}`]
      : []),
    ...(ctx.task.source_idea
      ? [`source_idea: ${yamlString(toWikilink(ctx.task.source_idea))}`]
      : []),
    "---",
    "",
    `# ${oneLine(bundle.title)}`,
    "",
    "## Research question",
    "",
    bundle.question.trim(),
    "",
    "## Executive summary",
    "",
    bundle.executiveSummary.trim(),
    "",
  ];

  if (bundle.facts.length > 0) {
    lines.push("## Evidence and facts", "");
    for (const fact of bundle.facts) {
      lines.push(
        `- **${oneLine(fact.claim)}**`,
        `  - 证据：${oneLine(fact.evidence)}`,
        `  - 来源：${fact.sourceIds.join(", ")}`,
      );
    }
  }

  if (bundle.inferences.length > 0 || bundle.recommendations.length > 0) {
    lines.push("", "## Analysis", "");
    if (bundle.inferences.length > 0) {
      lines.push("### Inferences", "", ...bulletLines(bundle.inferences));
    }
    if (bundle.recommendations.length > 0) {
      lines.push("", "### Recommendations", "", ...bulletLines(bundle.recommendations));
    }
  } else {
    lines.push(
      "",
      "## Analysis",
      "",
      "- 无额外推断或建议，当前结论仅限事实和证据范围。",
    );
  }
  if (bundle.perspectives.length > 0) {
    lines.push("", "## Perspectives and red-team review", "");
    for (const perspective of bundle.perspectives) {
      lines.push(
        `### ${oneLine(perspective.label)}${perspective.redTeam ? "（反方审查）" : ""}`,
        "",
        `- 观点：${oneLine(perspective.viewpoint)}`,
        `- 来源：${perspective.sourceIds.join(", ")}`,
        "",
      );
    }
  }

  if (bundle.unknowns.length > 0 || bundle.limitations.length > 0) {
    lines.push("", "## Unknowns and limitations", "");
    if (bundle.unknowns.length > 0) {
      lines.push("### Unknowns", "", ...bulletLines(bundle.unknowns));
    }
    if (bundle.limitations.length > 0) {
      lines.push("", "### Limitations", "", ...bulletLines(bundle.limitations));
    }
  } else {
    lines.push(
      "",
      "## Unknowns and limitations",
      "",
      "- 当前没有记录到额外的未知点或限制。",
    );
  }
  if (bundle.method.length > 0 || bundle.stopReason.trim()) {
    lines.push("", "## Scope and method", "", ...bulletLines(bundle.method));
    if (bundle.stopReason.trim()) {
      lines.push(`- 停止依据：${oneLine(bundle.stopReason)}`);
    }
  }
  if (bundle.sources.length > 0) {
    lines.push("", "## Sources", "");
    for (const source of bundle.sources) {
      const displayTitle = source.verified
        ? oneLine(source.title)
        : "未知（无法核验）";
      lines.push(
        `### ${source.id} ${displayTitle}`,
        `- 类型：${source.kind}`,
        `- 作者或机构：${source.verified ? unknownIfEmpty(source.authorOrInstitution) : "未知（无法核验）"}`,
        `- 发布日期：${source.verified ? unknownIfEmpty(source.publishedAt) : "未知（无法核验）"}`,
        `- 访问日期：${source.verified ? unknownIfEmpty(source.accessedAt) : "未知（无法核验）"}`,
        `- 完整 URL：${source.verified && source.url ? `[${source.url}](${source.url})` : "未知（无法核验）"}`,
        `- 适用范围：${oneLine(source.scope)}`,
        `- 限制：${oneLine(source.limitations)}`,
        `- 证据摘录：${oneLine(source.evidence)}`,
        "",
      );
    }
  }

  if ((ctx.task.related_briefs ?? []).length > 0) {
    lines.push("", "## Related research", "");
    lines.push(
      ...(ctx.task.related_briefs ?? []).map((brief) => `- ${toWikilink(brief)}`),
    );
  }

  lines.push("", "## Related notes", "");
  for (const sourcePath of sourcePaths(ctx.task)) {
    lines.push(`- ${toWikilink(sourcePath)}`);
  }
  if (bundle.followUpIdeas && bundle.followUpIdeas.length > 0) {
    lines.push("", "## Follow-up ideas", "");
    lines.push(
      ...bundle.followUpIdeas.map(
        (idea) => `- ${oneLine(idea)}（来源简报：${toWikilink(target.relativePath)}）`,
      ),
    );
  }

  if (target.previousBody !== undefined) {
    if (!bundle.evidenceChanges || bundle.evidenceChanges.length === 0) {
      throw new Error("刷新研究简报时缺少证据差异记录");
    }
    lines.push(
      "",
      "## Evidence changes",
      "",
      `- 旧结论摘要：${oneLine(extractSection(target.previousBody, "## Executive summary") ?? "未知")}`,
      ...bundle.evidenceChanges.map((change) => `- ${oneLine(change)}`),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function updateSourceNote(
  ctx: ResearchRunnerContext,
  sourcePath: string,
  briefPath: string | undefined,
  status: "complete" | "partial" | "blocked",
  needsResearch: boolean,
  researchError?: string,
): Promise<void> {
  const absolutePath = path.join(ctx.vaultPath, sourcePath);
  const original = await readFile(absolutePath, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const fields: Record<string, string> = {
    needs_research: String(needsResearch),
    research_status: status,
  };
  if (status === "complete") {
    fields.research_error = "";
  } else {
    fields.research_error = JSON.stringify(
      oneLine(researchError ?? `研究任务状态为 ${status}`),
    );
  }
  let withMetadata = updateFrontmatter(original, fields);
  if (status === "complete") {
    withMetadata = removeFrontmatterField(withMetadata, "research_error");
  }
  const briefLink = briefPath ? toWikilink(briefPath) : undefined;
  if (!briefLink) {
    await writeFile(absolutePath, withMetadata, "utf8");
    return;
  }
  if (withMetadata.includes(briefLink)) {
    await writeFile(absolutePath, withMetadata, "utf8");
    return;
  }
  const trimmed = withMetadata.replace(/\s+$/, "");
  const next = [
    trimmed,
    "",
    "## Research links",
    `- ${dateOnly(ctx.now.toISOString())}：研究问题「${oneLine(ctx.task.question)}」：${briefLink}`,
    "",
  ].join(eol);
  await writeFile(absolutePath, next, "utf8");
}

export async function markResearchPending(
  ctx: ResearchRunnerContext,
  status: "partial" | "blocked",
  briefPath?: string,
  lastError?: string,
): Promise<void> {
  const failures: string[] = [];
  for (const sourcePath of sourcePaths(ctx.task)) {
    try {
      await updateSourceNote(
        ctx,
        sourcePath,
        briefPath,
        status,
        true,
        lastError,
      );
    } catch (error) {
      failures.push(`${sourcePath}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new ResearchWritebackError(
      `研究来源状态写回失败: ${failures.join("; ")}`,
    );
  }
}

function updateFrontmatter(
  body: string,
  fields: Record<string, string>,
): string {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) {
    const fieldLines = Object.entries(fields).map(
      ([key, value]) => `${key}: ${value}`,
    );
    return ["---", ...fieldLines, "---", "", body].join(eol);
  }

  const currentLines = (match[1] ?? "").split(/\r?\n/);
  const replaced = new Set<string>();
  const nextLines = currentLines.map((line) => {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field || fields[field[1]!] === undefined) return line;
    replaced.add(field[1]!);
    return `${field[1]}: ${fields[field[1]!]}`;
  });
  for (const [key, value] of Object.entries(fields)) {
    if (!replaced.has(key)) nextLines.push(`${key}: ${value}`);
  }
  const nextHeader = ["---", ...nextLines, "---"].join(eol);
  return nextHeader + body.slice(match[0].length);
}

function removeFrontmatterField(body: string, key: string): string {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) return body;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = (match[1] ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.match(new RegExp(`^${escapeRegExp(key)}:`)));
  const nextHeader = ["---", ...lines, "---"].join(eol);
  return nextHeader + body.slice(match[0].length);
}

function sourcePaths(task: ResearchTask): string[] {
  return [...new Set([task.source_diary, task.source_idea].filter(Boolean))] as string[];
}

function sourceLinkPath(sourcePath: string | undefined): string | undefined {
  return sourcePath ? sourcePath.replace(/\\/g, "/").replace(/\.md$/, "") : undefined;
}

function toWikilink(relativePath: string): string {
  return sourceWikilink(relativePath)!;
}

function sourceWikilink(relativePath: string | undefined): string | undefined {
  return relativePath ? `[[${sourceLinkPath(relativePath)}]]` : undefined;
}

async function readResearchFile(
  absolutePath: string,
  relativePath: string,
): Promise<string> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) throw error;
    throw new ResearchReadError(
      `研究简报读取失败: ${relativePath}: ${errorMessage(error)}`,
      error,
    );
  }
}

function normalizePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function safeFilePart(value: string): string {
  const safe = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
  return safe || "研究简报";
}

function parseFrontmatter(body: string): Record<string, string> {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) return {};
  const metadata: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    metadata[field[1]!] = unquoteYaml(field[2]!);
  }
  return metadata;
}

function unquoteYaml(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function yamlString(value: string): string {
  return JSON.stringify(oneLine(value));
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function isDateOnly(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unknownIfEmpty(value: string): string {
  return value.trim() || "未知";
}

function bulletLines(values: string[]): string[] {
  return values.map((value) => `- ${oneLine(value)}`);
}

function extractSection(body: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(
      `^${escaped}\\r?\\n(?:\\r?\\n)?([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
      "m",
    ),
  );
  return match?.[1]?.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
