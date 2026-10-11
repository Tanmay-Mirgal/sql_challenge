/**
 * Bounded FIFO job queue with a global concurrency limit and a per-key
 * (per-participant) concurrency + backlog limit. Keeps one participant from
 * monopolising the SQL engine and sheds load instead of queueing without bound.
 */
export class QueueRejectedError extends Error {
  constructor(
    readonly reason: "queue_full" | "user_backlog",
    message: string,
  ) {
    super(message);
    this.name = "QueueRejectedError";
  }
}

export interface JobQueueOptions {
  concurrency: number;
  perKeyConcurrency: number;
  maxQueued: number;
  /** Maximum jobs a single key may have waiting (in addition to running). */
  maxQueuedPerKey: number;
}

interface PendingJob<T> {
  key: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class JobQueue {
  private readonly pending: Array<PendingJob<unknown>> = [];
  private readonly runningByKey = new Map<string, number>();
  private running = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: JobQueueOptions) {}

  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new QueueRejectedError("queue_full", "The execution queue is shutting down."));
    if (this.pending.length >= this.options.maxQueued) {
      return Promise.reject(new QueueRejectedError("queue_full", "The SQL engine is busy. Please try again in a moment."));
    }
    const waitingForKey = this.pending.filter((job) => job.key === key).length;
    if (waitingForKey >= this.options.maxQueuedPerKey) {
      return Promise.reject(new QueueRejectedError("user_backlog", "You already have queries waiting. Let them finish first."));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ key, run, resolve, reject } as PendingJob<unknown>);
      this.pump();
    });
  }

  /** Would a new job for `key` be accepted right now? */
  canAdmit(key: string): boolean {
    if (this.closed || this.pending.length >= this.options.maxQueued) return false;
    return this.pending.filter((job) => job.key === key).length < this.options.maxQueuedPerKey;
  }

  private pump(): void {
    if (this.running >= this.options.concurrency) return;
    for (let i = 0; i < this.pending.length && this.running < this.options.concurrency; ) {
      const job = this.pending[i]!;
      if ((this.runningByKey.get(job.key) ?? 0) >= this.options.perKeyConcurrency) {
        i += 1; // this participant is at their limit; let others pass
        continue;
      }
      this.pending.splice(i, 1);
      this.start(job);
    }
  }

  private start(job: PendingJob<unknown>): void {
    this.running += 1;
    this.runningByKey.set(job.key, (this.runningByKey.get(job.key) ?? 0) + 1);
    void job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running -= 1;
        const left = (this.runningByKey.get(job.key) ?? 1) - 1;
        if (left <= 0) this.runningByKey.delete(job.key);
        else this.runningByKey.set(job.key, left);
        this.pump();
        if (this.running === 0 && this.pending.length === 0) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
      });
  }

  stats() {
    return { running: this.running, queued: this.pending.length, concurrency: this.options.concurrency };
  }

  /** Stop accepting jobs and resolve once everything in flight has finished. */
  async drain(): Promise<void> {
    this.closed = true;
    if (this.running === 0 && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}
