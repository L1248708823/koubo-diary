import { logError, logInfo } from "../runtime/log.js";

export type ProcessorQueueRunResult = {
  status: string;
  progressed: boolean;
};

export type ProcessorQueue = {
  enqueue(): void;
  waitForIdle(): Promise<void>;
};

export type ProcessorQueueOptions = {
  run(retryResearch?: boolean): Promise<ProcessorQueueRunResult>;
  hasWork(includeRetryableResearch?: boolean): Promise<boolean>;
  label?: string;
  /** 每处理多少轮主动让出事件循环，不限制最终消费的总轮数。 */
  yieldEveryRounds?: number;
};

export function createMergedProcessorQueue(
  options: ProcessorQueueOptions,
): ProcessorQueue {
  const label = options.label ?? "local";
  const yieldEveryRounds = Math.max(1, options.yieldEveryRounds ?? 100);
  let running = false;
  let pending = false;
  let pendingSince: number | undefined;
  let drainPromise: Promise<void> | undefined;

  function enqueue(): void {
    const merged = running || pending;
    if (!pending) pendingSince = Date.now();
    pending = true;
    logInfo(merged ? "processor.queue_merged" : "processor.queue_enqueued", {
      label,
    });
    if (!running) {
      startDrain();
    }
  }

  function startDrain(): void {
    if (running) return;
    running = true;
    drainPromise = drain().finally(() => {
      running = false;
      drainPromise = undefined;
    });
  }

  async function drain(): Promise<void> {
    let rounds = 0;
    while (true) {
      const requested = pending;
      pending = false;
      const hasWork = await options.hasWork(requested);
      if (!requested && !hasWork) {
        logInfo("processor.queue_idle", { label, rounds });
        return;
      }
      if (!hasWork) continue;

      rounds += 1;
      const waitMs = pendingSince === undefined ? 0 : Date.now() - pendingSince;
      pendingSince = undefined;
      logInfo("processor.queue_started", { label, round: rounds, waitMs });
      let result: ProcessorQueueRunResult;
      try {
        result = await options.run(requested);
      } catch (error) {
        logError("processor.queue_failed", {
          label,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      logInfo("processor.queue_finished", {
        label,
        round: rounds,
        status: result.status,
        progressed: result.progressed,
      });

      if (result.status !== "success" || !result.progressed) return;
      if (rounds % yieldEveryRounds === 0) {
        logInfo("processor.queue_yield", {
          label,
          rounds,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  return {
    enqueue,
    async waitForIdle(): Promise<void> {
      await drainPromise;
    },
  };
}
