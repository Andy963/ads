import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import WebPushSettings from "../components/WebPushSettings.vue";

const propertyNames = ["isSecureContext", "Notification"] as const;
const originalWindowProperties = new Map<string, PropertyDescriptor | undefined>();
let originalServiceWorker: PropertyDescriptor | undefined;

afterEach(() => {
  for (const name of propertyNames) {
    const descriptor = originalWindowProperties.get(name);
    if (descriptor) Object.defineProperty(window, name, descriptor);
    else Reflect.deleteProperty(window, name);
  }
  originalWindowProperties.clear();
  if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  else Reflect.deleteProperty(navigator, "serviceWorker");
  originalServiceWorker = undefined;
  vi.unstubAllGlobals();
});

function installPushEnvironment() {
  for (const name of propertyNames) {
    originalWindowProperties.set(name, Object.getOwnPropertyDescriptor(window, name));
  }
  originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  vi.stubGlobal("PushManager", class PushManager {});

  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = requestPermission;
  }
  Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });

  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/device?token=private",
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/device?token=private", keys: { p256dh: "key", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
  const pushManager = {
    getSubscription: vi.fn(async () => null as typeof subscription | null),
    subscribe: vi.fn(async () => subscription),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  return { requestPermission, pushManager, subscription };
}

describe("Web Push settings", () => {
  it("requests permission only from the enable action and registers or removes this device", async () => {
    const environment = installPushEnvironment();
    const api = {
      get: vi.fn(async () => ({ enabled: true, publicKey: "B".repeat(86) })),
      post: vi.fn(async () => ({ success: true })),
      delete: vi.fn(async () => ({ success: true })),
    };
    const wrapper = mount(WebPushSettings, { props: { api: api as any } });
    await flushPromises();

    expect(environment.requestPermission).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="web-push-enable"]').trigger("click");
    await flushPromises();
    expect(environment.requestPermission).toHaveBeenCalledOnce();
    expect(environment.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(api.post).toHaveBeenCalledWith("/api/web-push/subscription", environment.subscription.toJSON());
    expect(wrapper.get('[data-testid="web-push-settings"]').text()).toContain("Notifications are enabled");

    environment.pushManager.getSubscription.mockResolvedValue(environment.subscription);
    await wrapper.get('[data-testid="web-push-disable"]').trigger("click");
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith("/api/web-push/unsubscribe", { endpoint: environment.subscription.endpoint });
    expect(environment.subscription.unsubscribe).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("explains that iPhone Safari must launch the installed Home Screen app", async () => {
    installPushEnvironment();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    const api = { get: vi.fn(async () => ({ enabled: true, publicKey: "public-key" })) };
    const wrapper = mount(WebPushSettings, { props: { api: api as any } });
    await flushPromises();

    expect(wrapper.text()).toMatch(/add ADS to your Home Screen/i);
    expect(wrapper.get('[data-testid="web-push-enable"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
    Reflect.deleteProperty(navigator, "userAgent");
  });
});
