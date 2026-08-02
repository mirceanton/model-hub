type Job = () => Promise<void>;

/**
 * Trivial in-process bounded-concurrency queue for thumbnail jobs — no
 * Redis/BullMQ, matching the "no separate worker service" architecture
 * decision. Each job is a full Chromium page render, so concurrency stays
 * low by default (see THUMBNAIL_CONCURRENCY).
 */
export class ThumbnailQueue {
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
          // generateThumbnail never rejects — this is just a safety net.
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
