import { thumbnailQueueDepth, thumbnailQueueInFlight } from "../metrics/thumbnail-metrics.js";

type Job = () => Promise<void>;

/**
 * Trivial in-process bounded-concurrency queue for thumbnail jobs — no
 * Redis/BullMQ, matching the "no separate worker service" architecture
 * decision. Each job is a full Chromium page render, so concurrency stays
 * low by default (see THUMBNAIL_CONCURRENCY).
 *
 * Depth/in-flight gauges are updated right here rather than polled from
 * outside, since `pending`/`active` are private to this class. Job
 * success/failure counters live in generate.ts/trigger.ts instead — this
 * queue only knows a job ran, not how it turned out (see the comment on
 * the catch below).
 */
export interface ThumbnailQueueState {
  pending: number;
  active: number;
}

export class ThumbnailQueue {
  private readonly concurrency: number;
  private active = 0;
  private readonly pending: Job[] = [];

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  /**
   * Reads the same `pending`/`active` fields the gauges above are set from —
   * the instance stats page (issue #73) calls this via trigger.ts's
   * getThumbnailQueueState() instead of scraping /metrics or recomputing
   * queue depth some other way.
   */
  getState(): ThumbnailQueueState {
    return { pending: this.pending.length, active: this.active };
  }

  enqueue(job: Job): void {
    this.pending.push(job);
    thumbnailQueueDepth.set(this.pending.length);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) return;
      thumbnailQueueDepth.set(this.pending.length);
      this.active += 1;
      thumbnailQueueInFlight.set(this.active);
      job()
        .catch(() => {
          // generateThumbnail never rejects — this is just a safety net.
        })
        .finally(() => {
          this.active -= 1;
          thumbnailQueueInFlight.set(this.active);
          this.drain();
        });
    }
  }
}
