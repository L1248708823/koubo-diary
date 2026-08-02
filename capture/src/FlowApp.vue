<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import LogicFlow from "@logicflow/core";
import { Control, MiniMap } from "@logicflow/extension";
import "@logicflow/core/lib/index.css";
import "@logicflow/extension/lib/index.css";
import "./flow.css";

type NodeDetail = {
  title: string;
  kind: string;
  owner: "人" | "AI" | "系统" | "AI + 系统";
  description: string;
  result: string;
};

type Palette = {
  fill: string;
  stroke: string;
  text: string;
};

const canvas = ref<HTMLDivElement | null>(null);
const details: Record<string, NodeDetail> = {};
const palettes: Record<string, Palette> = {
  input: { fill: "#e7f0ff", stroke: "#5b86d6", text: "#1e3a68" },
  process: { fill: "#e9f7dc", stroke: "#77a84a", text: "#29451b" },
  decision: { fill: "#fff3d7", stroke: "#d69a32", text: "#674810" },
  output: { fill: "#f1e7ff", stroke: "#956bc7", text: "#492c69" },
  guard: { fill: "#ffe8e4", stroke: "#d9786c", text: "#71352e" },
};

function addNode(
  id: string,
  type: "rect" | "diamond",
  x: number,
  y: number,
  text: string,
  detail: NodeDetail,
  palette: Palette,
) {
  details[id] = detail;
  return {
    id,
    type,
    x,
    y,
    text,
    properties: {
      width: type === "diamond" ? 190 : 210,
      height: type === "diamond" ? 110 : 76,
      style: {
        fill: palette.fill,
        stroke: palette.stroke,
        strokeWidth: 2,
      },
      textStyle: {
        color: palette.text,
        fontSize: 14,
      },
    },
  };
}

function addEdge(id: string, sourceNodeId: string, targetNodeId: string, text?: string) {
  return {
    id,
    type: "polyline",
    sourceNodeId,
    targetNodeId,
    ...(text ? { text } : {}),
  };
}

const graphData = {
  nodes: [
    addNode(
      "capture",
      "rect",
      520,
      90,
      "人：语音录入\n随手记录",
      {
        title: "语音录入 / 随手记录",
        kind: "输入",
        owner: "人",
        description: "人通过手机系统语音输入法说下内容，转成文字后随手提交。项目保存文字，不负责录音和语音识别。",
        result: "形成一条待处理的新记录。",
      },
      palettes.input,
    ),
    addNode(
      "sync-in",
      "rect",
      520,
      230,
      "系统：同步最新资料",
      {
        title: "同步最新资料",
        kind: "同步",
        owner: "系统",
        description: "正式环境先取得最新版本，再保存新记录，确保不同设备看到同一份资料。",
        result: "新记录进入处理范围。",
      },
      palettes.input,
    ),
    addNode(
      "loop",
      "rect",
      520,
      370,
      "系统：启动 AI loop",
      {
        title: "启动 AI loop",
        kind: "处理循环",
        owner: "系统",
        description: "系统锁定一轮处理范围，每轮只领取一批新内容，避免重复处理和并发写入。",
        result: "得到本轮明确的处理清单。",
      },
      palettes.process,
    ),
    addNode(
      "clean",
      "rect",
      520,
      510,
      "AI：轻整理",
      {
        title: "轻整理",
        kind: "AI 处理",
        owner: "AI",
        description: "AI 去掉重复、语气词和明显口头赘词，调整断句，保留原意和说话方式。整理过程遵循原文，不补写事实和结论。",
        result: "得到可以写回的整理内容。",
      },
      palettes.process,
    ),
    addNode(
      "classify",
      "diamond",
      520,
      680,
      "AI：自动分析类型",
      {
        title: "自动分析类型",
        kind: "AI 分类",
        owner: "AI",
        description: "AI 分别判断三件事：是否属于当天日记，是否值得独立保存为想法，是否存在需要查资料的事实或可行性问题。",
        result: "一条记录可以同时进入日记、想法和调研任务。",
      },
      palettes.decision,
    ),
    addNode(
      "diary",
      "rect",
      190,
      870,
      "日记：日常 / 牢骚",
      {
        title: "日记：日常 / 牢骚",
        kind: "内容归档",
        owner: "AI + 系统",
        description: "AI 判断这段内容属于当天经历、情绪、牢骚或过程记录，系统把整理后的文字写入对应日期。",
        result: "日常经历可以按天回看。",
      },
      palettes.output,
    ),
    addNode(
      "idea",
      "rect",
      520,
      870,
      "想法：灵感 / 方法",
      {
        title: "想法：灵感 / 方法",
        kind: "内容归档",
        owner: "AI + 系统",
        description: "AI 判断内容是否脱离当天背景仍值得回看，例如灵感、原则、方法或产品想法；系统单独保存并建立关联。",
        result: "重要想法不会埋在日常记录里。",
      },
      palettes.output,
    ),
    addNode(
      "research-task",
      "rect",
      850,
      870,
      "调研任务：事实 / 可行性",
      {
        title: "调研任务：事实 / 可行性",
        kind: "任务分流",
        owner: "AI + 系统",
        description: "AI 发现事实、资料、对比或可行性缺口时，系统保存问题、来源和任务状态，等待 Research loop 处理。",
        result: "模糊疑问变成可追踪任务。",
      },
      palettes.decision,
    ),
    addNode(
      "content-accept",
      "rect",
      520,
      1040,
      "系统：内容验收",
      {
        title: "内容验收",
        kind: "安全检查",
        owner: "系统",
        description: "检查结果文件、链接、状态、处理范围和原始记录保护情况。",
        result: "通过后才允许清理已完成的新记录。",
      },
      palettes.guard,
    ),
    addNode(
      "retry",
      "rect",
      1050,
      1040,
      "系统：保留并重试",
      {
        title: "保留并重试",
        kind: "失败恢复",
        owner: "系统",
        description: "验收失败时保留原始内容，记录失败原因，达到条件后进入隔离区。",
        result: "失败不会直接造成内容丢失。",
      },
      palettes.guard,
    ),
    addNode(
      "research-check",
      "diamond",
      520,
      1190,
      "系统：有调研任务？",
      {
        title: "有调研任务？",
        kind: "流程分支",
        owner: "系统",
        description: "内容阶段完成后，检查本轮是否产生需要进一步核验的问题。",
        result: "没有任务时直接同步；有任务时进入研究阶段。",
      },
      palettes.decision,
    ),
    addNode(
      "research-loop",
      "rect",
      850,
      1350,
      "AI：Research loop",
      {
        title: "Research loop",
        kind: "研究阶段",
        owner: "AI",
        description: "AI 定义问题、收集来源、建立证据记录，并主动寻找相反观点和失败条件。",
        result: "得到有来源支持的研究材料。",
      },
      palettes.process,
    ),
    addNode(
      "brief",
      "rect",
      850,
      1500,
      "AI + 系统：研究简报",
      {
        title: "研究简报",
        kind: "研究输出",
        owner: "AI + 系统",
        description: "AI 整理结论、证据、来源、不同观点、未知点和限制，系统写入简报并回链原始记录。",
        result: "研究结果可以复查和继续更新。",
      },
      palettes.output,
    ),
    addNode(
      "research-accept",
      "rect",
      850,
      1650,
      "系统：研究验收",
      {
        title: "研究验收",
        kind: "安全检查",
        owner: "系统",
        description: "检查来源是否真实、证据是否足够、状态是否匹配实际完成程度。",
        result: "完成后关闭待研究标记；证据不足时保留任务。",
      },
      palettes.guard,
    ),
    addNode(
      "pending-research",
      "rect",
      1110,
      1650,
      "系统：保留调研任务",
      {
        title: "保留调研任务",
        kind: "研究恢复",
        owner: "系统",
        description: "研究资料不足或来源暂时不可访问时，保存已有证据和后续步骤。",
        result: "下一轮可以继续研究。",
      },
      palettes.guard,
    ),
    addNode(
      "git-publish",
      "rect",
      520,
      1840,
      "系统：提交并同步 Git",
      {
        title: "提交并同步 Git",
        kind: "版本同步",
        owner: "系统",
        description: "通过验收的日记、想法、研究结果和状态统一提交，供其他设备同步查看。",
        result: "每一轮结果都有版本记录。",
      },
      palettes.input,
    ),
    addNode(
      "view",
      "rect",
      520,
      1980,
      "人：查看结果",
      {
        title: "查看结果",
        kind: "结果使用",
        owner: "人",
        description: "人查看当天日记、长期想法和研究结果，再决定要继续记录、实践或提出新的问题。",
        result: "等待下一批新内容，进入下一轮。",
      },
      palettes.input,
    ),
  ],
  edges: [
    addEdge("e-capture-sync", "capture", "sync-in"),
    addEdge("e-sync-loop", "sync-in", "loop"),
    addEdge("e-loop-clean", "loop", "clean"),
    addEdge("e-clean-classify", "clean", "classify"),
    addEdge("e-classify-diary", "classify", "diary", "写入"),
    addEdge("e-classify-idea", "classify", "idea", "长期保留"),
    addEdge("e-classify-research", "classify", "research-task", "需要查资料"),
    addEdge("e-diary-accept", "diary", "content-accept"),
    addEdge("e-idea-accept", "idea", "content-accept"),
    addEdge("e-task-accept", "research-task", "content-accept"),
    addEdge("e-accept-research-check", "content-accept", "research-check"),
    addEdge("e-accept-retry", "content-accept", "retry", "失败"),
    addEdge("e-retry-loop", "retry", "loop", "下一轮重试"),
    addEdge("e-check-publish", "research-check", "git-publish", "没有调研任务"),
    addEdge("e-check-research", "research-check", "research-loop", "有调研任务"),
    addEdge("e-research-brief", "research-loop", "brief"),
    addEdge("e-brief-accept", "brief", "research-accept"),
    addEdge("e-research-pending", "research-accept", "pending-research", "partial / blocked"),
    addEdge("e-research-pending-publish", "pending-research", "git-publish", "保留状态"),
    addEdge("e-research-publish", "research-accept", "git-publish", "complete"),
    addEdge("e-publish-view", "git-publish", "view"),
  ],
};

const selected = ref<NodeDetail>(details.capture!);
let lf: LogicFlow | undefined;
let resizeObserver: ResizeObserver | undefined;

function fitView(): void {
  lf?.fitView(48, 48);
}

function resetView(): void {
  lf?.resetZoom();
  lf?.resetTranslate();
  fitView();
}

function ownerClass(owner: NodeDetail["owner"]): string {
  if (owner === "人") return "human";
  if (owner === "AI") return "ai";
  if (owner === "系统") return "system";
  return "hybrid";
}

onMounted(() => {
  if (!canvas.value) return;

  lf = new LogicFlow({
    container: canvas.value,
    edgeType: "polyline",
    grid: {
      size: 16,
      visible: true,
      type: "dot",
      config: { color: "#d7dee8", thickness: 1 },
    },
    keyboard: { enabled: false },
    isSilentMode: true,
    plugins: [Control, MiniMap],
  });

  lf.setTheme({
    rect: { radius: 12 },
    diamond: { strokeWidth: 2 },
    polyline: { stroke: "#718096", strokeWidth: 1.5 },
    nodeText: {
      color: "#27364a",
      fontSize: 14,
      overflowMode: "autoWrap",
      wrapPadding: "8px 12px",
    },
    edgeText: {
      color: "#5b6b80",
      fontSize: 12,
      background: { fill: "#ffffff", stroke: "none", wrapPadding: "4px 6px" },
    },
    arrow: { offset: 8, verticalLength: 5, fill: "#718096", stroke: "#718096" },
  });

  lf.render(graphData);
  lf.on("node:click", (event) => {
    const payload = event as { data?: { id?: string } };
    const nodeId = payload.data?.id;
    if (nodeId && details[nodeId]) selected.value = details[nodeId];
  });

  resizeObserver = new ResizeObserver(() => lf?.resize());
  resizeObserver.observe(canvas.value);
  requestAnimationFrame(fitView);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  lf?.destroy();
});
</script>

<template>
  <main class="flow-page">
    <header class="flow-header">
      <div>
        <p class="flow-eyebrow">AI PROCESSING LOOP</p>
        <h1>从语音录入到日记、想法与调研</h1>
        <p class="flow-lede">人负责记录和查看，AI 负责理解和研究，系统负责同步、写入、验收和持续运行。</p>
      </div>
      <a class="back-link" href="/">返回记录</a>
    </header>

    <section class="flow-layout">
      <div class="flow-canvas-card">
        <div class="flow-toolbar">
          <span>点击节点查看说明，拖动画布或使用右侧工具调整视图。</span>
          <div class="flow-toolbar-actions">
            <button type="button" @click="fitView">适应画布</button>
            <button type="button" @click="resetView">重置视图</button>
          </div>
        </div>
        <div ref="canvas" class="flow-canvas" aria-label="AI processing loop 流程图" />
      </div>

      <aside class="flow-detail-card">
        <p class="flow-detail-kicker">当前节点 · {{ selected.kind }}</p>
        <div class="flow-owner-row">
          <span>执行者</span>
          <strong :class="`owner-${ownerClass(selected.owner)}`">{{ selected.owner }}</strong>
        </div>
        <h2>{{ selected.title }}</h2>
        <p>{{ selected.description }}</p>
        <div class="flow-result">
          <span>输出</span>
          <strong>{{ selected.result }}</strong>
        </div>
        <div class="flow-legend">
          <span><i class="legend-dot input" />输入与同步</span>
          <span><i class="legend-dot process" />AI 处理</span>
          <span><i class="legend-dot decision" />分类与分支</span>
          <span><i class="legend-dot output" />内容输出</span>
          <span><i class="legend-dot guard" />验收与恢复</span>
        </div>
        <div class="flow-responsibilities">
          <h3>职责分工</h3>
          <p><strong>人</strong> 通过语音输入法随手记录，查看结果并决定继续什么。</p>
          <p><strong>AI</strong> 轻整理内容，自动分析日记、想法和调研任务，执行资料研究。</p>
          <p><strong>系统</strong> 负责 Git 同步、分轮运行、写入文件、验收、重试和状态更新。</p>
        </div>
      </aside>
    </section>
  </main>
</template>
