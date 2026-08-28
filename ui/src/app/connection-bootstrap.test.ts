import { describe, expect, it, vi } from "vitest";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("connection bootstrap coordinator", () => {
  it("deduplicates bootstrap work and caps its connection concurrency", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client: {}, connected: true });
    let active = 0;
    let maximum = 0;
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const run = (completion: ReturnType<typeof deferred>) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await completion.promise;
      active -= 1;
    };

    const firstTask = coordinator.run("first", run(first));
    const duplicateFirstTask = coordinator.run("first", run(first));
    const secondTask = coordinator.run("second", run(second));
    const thirdTask = coordinator.run("third", run(third));

    expect(duplicateFirstTask).toBe(firstTask);
    expect(maximum).toBe(2);
    first.resolve();
    await firstTask;
    expect(maximum).toBe(2);
    second.resolve();
    third.resolve();
    await Promise.all([secondTask, thirdTask]);
    expect(maximum).toBe(2);
  });

  it("does not start queued work after its connection is replaced", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client: {}, connected: true });
    const first = deferred();
    const second = deferred();
    let staleStarted = false;
    const firstTask = coordinator.run("first", async () => await first.promise);
    const secondTask = coordinator.run("second", async () => await second.promise);
    const staleTask = coordinator.run("stale", async () => {
      staleStarted = true;
    });

    coordinator.synchronize({ client: {}, connected: true });
    first.resolve();
    second.resolve();
    await Promise.all([firstTask, secondTask, staleTask]);
    expect(staleStarted).toBe(false);
  });

  it("runs connected bootstrap work queued by an earlier subscription", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    const hydrate = vi.fn(async () => {});

    const queued = coordinator.run("sessions", hydrate);
    await Promise.resolve();
    expect(hydrate).not.toHaveBeenCalled();

    coordinator.synchronize({ client: {}, connected: true });
    await queued;

    expect(hydrate).toHaveBeenCalledOnce();
  });
});
