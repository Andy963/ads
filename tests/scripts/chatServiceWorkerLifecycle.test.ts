import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import {
  observeChatServiceWorkerLifecycle,
  waitForChatServiceWorkerLifecycle,
} from "../../scripts/lib/chat-service-worker-lifecycle.js";

function fixture() {
  const register = Promise.withResolvers<unknown>();
  const update = Promise.withResolvers<unknown>();
  const context = createContext({
    registerOperation: () => register.promise,
    updateOperation: () => update.promise,
    console: { debug() {} },
  });
  runInContext(`
    class ServiceWorkerRegistration { update() { return updateOperation(); } }
    class ServiceWorkerContainer { register() { return registerOperation(); } }
    const navigator = { serviceWorker: new ServiceWorkerContainer() };
    const window = {};
    const location = { href: "http://localhost/" };
    const registration = new ServiceWorkerRegistration();
    (${observeChatServiceWorkerLifecycle.toString()})();
  `, context);
  const evaluate = (callback: () => unknown) => runInContext(`(${callback.toString()})()`, context);
  const page = {
    async waitForLoadState(state: string) { assert.equal(state, "load"); },
    async waitForFunction(predicate: () => unknown) { assert.ok(evaluate(predicate)); },
    async evaluate(callback: () => unknown) { return evaluate(callback); },
  };
  return { context, register, update, page, run: (code: string) => runInContext(code, context) };
}

test("load and registration alone do not release the barrier; update must complete", async () => {
  const f = fixture();
  let ready: () => unknown = () => false;
  const release = Promise.withResolvers<void>();
  f.page.waitForFunction = async (predicate) => { ready = () => f.page.evaluate(predicate); await release.promise; };
  const barrier = waitForChatServiceWorkerLifecycle(f.page);
  await Promise.resolve();
  assert.equal(await ready(), false);
  const registered = f.run("navigator.serviceWorker.register('/sw.js')");
  f.register.resolve(f.run("registration"));
  await registered;
  assert.equal(await ready(), false, "The gap before update starts must not permit navigation");
  const updated = f.run("registration.update()");
  assert.equal(await ready(), false, "A pending update must not permit navigation");
  f.update.resolve(f.run("registration"));
  await updated;
  assert.equal(await ready(), true);
  release.resolve();
  assert.equal((await barrier).pending, 0);
});

for (const method of ["register", "update"] as const) {
  test(`${method} failure preserves rejection and makes the barrier fail`, async () => {
    const f = fixture();
    const error = new Error(`${method} failed`);
    const operation = f.run(method === "register" ? "navigator.serviceWorker.register('/sw.js')" : "registration.update()");
    const rejection = assert.rejects(operation, (actual) => actual === error);
    f[method].reject(error);
    await rejection;
    assert.equal(f.run("window.__chatServiceWorkerLifecycle.pending"), 0);
    await assert.rejects(waitForChatServiceWorkerLifecycle(f.page), /Service worker initialization failed/);
  });
}

test("instrumentation preserves synchronous errors without leaking pending operations", async () => {
  const f = fixture();
  f.context.registerOperation = () => { throw new Error("synchronous failure"); };
  assert.throws(() => f.run("navigator.serviceWorker.register('/sw.js')"), /synchronous failure/);
  assert.equal(f.run("window.__chatServiceWorkerLifecycle.pending"), 0);
  await assert.rejects(waitForChatServiceWorkerLifecycle(f.page), /synchronous failure/);
});
