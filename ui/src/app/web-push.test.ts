// Web push reconnect tests cover coordinator admission and stale-client fencing.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createWebPushCapability } from "./web-push.ts";

const subscription = {
  toJSON: () => ({
    endpoint: "https://push.example.test/subscription",
    keys: { auth: "auth", p256dh: "p256dh" },
  }),
};

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalPushManager = Object.getOwnPropertyDescriptor(window, "PushManager");
const originalWindowNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

function enableWebPush(
  getSubscription: () => Promise<typeof subscription | null> = async () => null,
) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription } }) },
  });
  Object.defineProperty(window, "PushManager", { configurable: true, value: {} });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "granted" },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "granted" },
  });
}

afterEach(() => {
  restoreProperty(navigator, "serviceWorker", originalServiceWorker);
  restoreProperty(window, "PushManager", originalPushManager);
  restoreProperty(window, "Notification", originalWindowNotification);
  restoreProperty(globalThis, "Notification", originalNotification);
  vi.restoreAllMocks();
});

describe("web push reconnect", () => {
  it("enrolls reconciliation in the connection bootstrap coordinator", async () => {
    enableWebPush(async () => subscription);
    const coordinatorRuns: string[] = [];
    const coordinator = {
      reset: () => {},
      run: async (key: string, task: () => Promise<void>) => {
        coordinatorRuns.push(key);
        await task();
      },
      synchronize: () => {},
    } satisfies ConnectionBootstrapCoordinator;
    const request = vi.fn<RequestFn>(async () => ({}));
    const harness = createGatewayHarness(null, false);
    const webPush = createWebPushCapability(harness.gateway, { connectionBootstrap: coordinator });
    await flushMicrotasks();
    expect(webPush.snapshot.supported).toBe(true);

    const gatewayClient = client(request);
    harness.update({ client: gatewayClient, phase: "connected" });
    await flushMicrotasks();

    expect(coordinatorRuns).toEqual(["web-push-reconcile"]);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("push.web.subscribe", subscription.toJSON());
    });
    webPush.dispose();
  });

  it("does not subscribe after its connection is replaced", async () => {
    const reconcileSubscription = deferred<typeof subscription | null>();
    const getSubscription = vi
      .fn<() => Promise<typeof subscription | null>>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(reconcileSubscription.promise);
    enableWebPush(getSubscription);
    const coordinator = {
      reset: () => {},
      run: async (_key: string, task: () => Promise<void>) => await task(),
      synchronize: () => {},
    } satisfies ConnectionBootstrapCoordinator;
    const request = vi.fn<RequestFn>(async () => ({}));
    const harness = createGatewayHarness(null, false);
    const webPush = createWebPushCapability(harness.gateway, { connectionBootstrap: coordinator });
    await flushMicrotasks();

    const gatewayClient = client(request);
    harness.update({ client: gatewayClient, phase: "connected" });
    harness.update({ client: null, phase: "stopped" });
    reconcileSubscription.resolve(subscription);
    await flushMicrotasks();

    expect(request).not.toHaveBeenCalled();
    webPush.dispose();
  });
});
