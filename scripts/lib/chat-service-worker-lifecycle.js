export function observeChatServiceWorkerLifecycle() {
  if (!("serviceWorker" in navigator)) return;
  const state = window.__chatServiceWorkerLifecycle = { pending: 0, registered: 0, updated: 0, failures: [] };
  for (const [prototype, method, counter] of [
    [ServiceWorkerContainer.prototype, "register", "registered"],
    [ServiceWorkerRegistration.prototype, "update", "updated"],
  ]) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      state.pending += 1;
      const report = (status, error) => console.debug("CHAT_SW_LIFECYCLE " + JSON.stringify({
        at: Date.now(), url: location.href, method, status, error: error ? String(error) : undefined,
      }));
      const reject = (error) => {
        state.pending -= 1;
        state.failures.push({ method, error: String(error) });
        report("rejected", error);
        // Preserve the original caller's rejection handling; this is not an error filter.
        throw error;
      };
      report("started");
      let operation;
      try { operation = original.apply(this, args); } catch (error) { return reject(error); }
      return operation.then((value) => {
        state.pending -= 1;
        state[counter] += 1;
        report("fulfilled");
        return value;
      }, reject);
    };
  }
}

export async function waitForChatServiceWorkerLifecycle(page) {
  await page.waitForLoadState("load");
  await page.waitForFunction(() => {
    const state = window.__chatServiceWorkerLifecycle;
    return state && (state.failures.length > 0 || (state.registered > 0 && state.updated > 0 && state.pending === 0));
  });
  const state = await page.evaluate(() => window.__chatServiceWorkerLifecycle);
  if (state.failures.length) throw new Error(`Service worker initialization failed: ${JSON.stringify(state.failures)}`);
  return state;
}

