/** Shared domain types for the processor loop. */

export type ReceiptStatus = "done" | "failed" | "quarantine";

export type ReceiptItemDone = {
  inbox: string;
  status: "done";
  diary: string;
  idea?: string;
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
};

export type VaultLayout = {
  vaultPath: string;
  inboxDir: string;
  quarantineDir: string;
  diaryDir: string;
  ideasDir: string;
  processorDir: string;
  stagingDir: string;
};

export type ProcessorOptions = {
  layout: VaultLayout;
  maxPerRound: number;
  maxAttempts: number;
};

export type ChangedPath = {
  path: string;
  /** git status short code, e.g. 'A', 'M', 'D', '??' */
  status: string;
};

export type GitResult =
  | { ok: true }
  | { ok: false; reason: string; conflict?: boolean };

export type GitOps = {
  pull(): Promise<GitResult>;
  push(): Promise<GitResult>;
  headRev(): Promise<string>;
  /** Working tree changes relative to HEAD (incl. untracked). */
  listChanges(): Promise<ChangedPath[]>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<GitResult>;
  /** Restore a path from HEAD (for unauthorized inbox deletes). */
  restoreFromHead(path: string): Promise<void>;
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
};

export type AgentRunner = {
  /** Mutate working tree and write `_processor/last-run.json`. */
  run(ctx: AgentContext): Promise<void>;
};

export type Clock = {
  now(): Date;
};
