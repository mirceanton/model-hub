type Job = () => Promise<void>;

/**
 * Trivial in-process bounded-concurrency queue for source-snapshot fetch
 * jobs — same "no Redis/BullMQ" shape as thumbnails/queue.ts, just for plain
 * HTTP fetches instead of full Chromium renders, so it can run a bit more
 * concurrently.
 */
export class SourceSnapshotQueue {
  private readonly concurrency: number;
  private active = 0;
  private readonly pending: Job[] = [];

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  enqueue(job: Job): void {
    this.pending.push(job);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) return;
      this.active += 1;
      job()
        .catch(() => {
          // generateSourceSnapshot never rejects — this is just a safety net.
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
