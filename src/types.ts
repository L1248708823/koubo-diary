/** Shared domain types for the processor loop. */

export type ReceiptStatus = "done" | "failed" | "quarantine";

export type ResearchTaskStatus =
  | "pending"
  | "running"
  | "partial"
  | "blocked"
  | "complete";

export type ResearchTask = {
  task_id: string;
  source_diary?: string;
  source_idea?: string;
  question: string;
  status: ResearchTaskStatus;
  created_at: string;
  updated_at: string;
  brief?: string;
  last_error?: string;
};

export type ResearchRunnerContext = {
  vaultPath: string;
  layout: VaultLayout;
  task: ResearchTask;
  now: Date;
  action?: "start" | "refresh";
};

export type ResearchRunnerResult = {
  status: Exclude<ResearchTaskStatus, "pending" | "running">;
  brief?: string;
  lastError?: string;
};

export type ResearchRunner = {
  run(ctx: ResearchRunnerContext): Promise<ResearchRunnerResult>;
};

export type ReceiptItemDone = {
  inbox: string;
  status: "done";
  diary: string;
  /** 兼容 v1 单想法回执；新回执使用 ideas 表达一条输入的多个想法。 */
  idea?: string;
  ideas?: string[];
  needs_research?: boolean;
  notes?: string;
};

export type ReceiptItemFailed = {
  inbox: string;
  status: "failed";
  error: string;
  attempts_observed?: number;
};

export type ReceiptItemQuarantine = {
  inbox: string;
  status: "quarantine";
  error?: string;
  attempts_observed?: number;
};

export type ReceiptItem =
  | ReceiptItemDone
  | ReceiptItemFailed
  | ReceiptItemQuarantine;

export type Receipt = {
  ok: boolean;
  round_id: string;
  round_ended_at: string;
  processed: ReceiptItemDone[];
  failed: ReceiptItemFailed[];
  quarantine: ReceiptItemQuarantine[];
};

export type RoundStatus =
  | "empty"
  | "success"
  | "failed"
  | "locked"
  | "conflict"
  | "aborted";

export type RoundResult = {
  status: RoundStatus;
  reason?: string;
  deletedInbox: string[];
  quarantined: string[];
  agentInvoked: boolean;
  progressed: boolean;
  researchProcessed: number;
  researchPending: number;
};

export type VaultLayout = {
  vaultPath: string;
  inboxDir: string;
  quarantineDir: string;
  diaryDir: string;
  ideasDir: string;
  researchDir: string;
  processorDir: string;
  stagingDir: string;
};

export type ProcessorOptions = {
  layout: VaultLayout;
  maxPerRound: number;
  maxAttempts: number;
  maxResearchPerRound: number;
};

export type ChangedPath = {
  path: string;
  previousPath?: string;
  /** git status short code, e.g. 'A', 'M', 'D', '??' */
  status: string;
};

export type GitResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      conflict?: boolean;
      /** 生产投递发布失败时，用于判断本地 inbox 是否已经进入 commit。 */
      committed?: boolean;
    };

export type VaultGitMode = "remote" | "local";

/** 工作区层：本地和生产都需要，负责准备轮次、检查变更和恢复越权删除。 */
export type VaultWorkspace = {
  prepare(): Promise<GitResult>;
  /** Working tree changes relative to the round baseline, including untracked. */
  listChanges(): Promise<ChangedPath[]>;
  /** Restore a path from the round baseline or production HEAD; remove new paths. */
  restore(path: string): Promise<void>;
};

/** 发布层：只有生产 vault 才注入，本地联调不会拥有这个能力。 */
export type VaultPublisher = {
  publish(paths: string[], message: string): Promise<GitResult>;
};

export type VaultAccess = {
  workspace: VaultWorkspace;
  publisher?: VaultPublisher;
};

export type LockHandle = {
  release(): Promise<void>;
};

export type Lock = {
  /** Acquire exclusive lock; return null if already held. */
  tryAcquire(): Promise<LockHandle | null>;
};

export type AgentContext = {
  vaultPath: string;
  layout: VaultLayout;
  maxPerRound: number;
  pendingInbox: string[];
  roundId: string;
  /** 编排器列出的、仅用于关联判断的顶层 Markdown 文件。 */
  associationCandidates?: {
    ideas: string[];
    research: string[];
  };
};

export type AgentRunner = {
  /** Mutate working tree and write `_processor/last-run.json`. */
  run(ctx: AgentContext): Promise<void>;
};

export type Clock = {
  now(): Date;
};
