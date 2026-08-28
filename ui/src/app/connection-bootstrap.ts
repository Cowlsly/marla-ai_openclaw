/** Coordinates automatic Control UI bootstrap work for one Gateway connection epoch. */

const MAX_CONNECTION_BOOTSTRAP_CONCURRENCY = 2;

type QueuedBootstrapTask = {
  generation: number;
  key: string;
  reject: (reason?: unknown) => void;
  resolve: () => void;
  run: () => Promise<void>;
  scheduled: Promise<void>;
};

export type ConnectionBootstrapCoordinator = {
  reset: () => void;
  run: (key: string, task: () => Promise<void>) => Promise<void>;
  synchronize: (params: { client: object | null; connected: boolean }) => void;
};

/**
 * Keeps automatic connection work bounded without serializing interactive RPCs.
 * A reconnect starts a new epoch; queued work from the prior client never starts.
 */
export function createConnectionBootstrapCoordinator(): ConnectionBootstrapCoordinator {
  let client: object | null = null;
  let generation = 0;
  let active = 0;
  const queued: QueuedBootstrapTask[] = [];
  const tasks = new Map<string, Promise<void>>();

  const drain = () => {
    while (active < MAX_CONNECTION_BOOTSTRAP_CONCURRENCY) {
      const task = queued.shift();
      if (!task) {
        return;
      }
      if (task.generation !== generation) {
        task.resolve();
        continue;
      }
      if (client === null) {
        queued.unshift(task);
        return;
      }
      active += 1;
      let work: Promise<void>;
      try {
        work = task.run();
      } catch (error) {
        work = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      void work
        .then(task.resolve, (error: unknown) => {
          if (tasks.get(task.key) === task.scheduled) {
            tasks.delete(task.key);
          }
          task.reject(error);
        })
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  const reset = () => {
    generation += 1;
    client = null;
    queued.splice(0).forEach((task) => task.resolve());
    tasks.clear();
  };

  return {
    reset,
    synchronize(params) {
      const nextClient = params.connected ? params.client : null;
      if (nextClient === client) {
        // A connected snapshot can publish before this coordinator's listener
        // runs. A later disconnected snapshot invalidates that queued work.
        if (nextClient === null && queued.length > 0) {
          reset();
        }
        return;
      }
      if (nextClient === null) {
        reset();
        return;
      }
      if (client !== null) {
        reset();
      }
      client = nextClient;
      drain();
    },
    run(key, task) {
      const current = tasks.get(key);
      if (current) {
        return current;
      }
      let resolve!: () => void;
      let reject!: (reason?: unknown) => void;
      const scheduled = new Promise<void>((resolveTask, rejectTask) => {
        resolve = resolveTask;
        reject = rejectTask;
      });
      tasks.set(key, scheduled);
      queued.push({ generation, key, reject, resolve, run: task, scheduled });
      drain();
      return scheduled;
    },
  };
}
