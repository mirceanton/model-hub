type Task<T> = () => Promise<T>;

const queues = new Map<string, Promise<void>>();

/**
 * Serializes async tasks that share the same key (a model's absolute path).
 * Prevents overlapping git/DB operations on the same working tree — e.g. a
 * watcher-triggered reconcile racing the periodic scan's reconcile for the
 * same model.
 */
export function runExclusive<T>(key: string, task: Task<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const settledPrevious = previous.catch(() => undefined);
  const run = settledPrevious.then(task);

  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );

  return run;
}
