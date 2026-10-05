import type { ActionTools, ActionToolResult, ActionToolName } from "../agents/actionTools.js";
import type { ReviewVerdict } from "../reviewer/types.js";

/** Authority belongs to one live parent, not a new resumable job state. */
export function createActionSupervision(options: {
  signal: AbortSignal;
  snapshot: () => string;
  review: (signal: AbortSignal) => Promise<ReviewVerdict>;
  assertDeliveryTarget?: (approved: string) => void;
  deliver: () => ActionToolResult;
}): ActionTools & { dispose: () => Promise<void> } {
  const children = new AbortController();
  const signal = AbortSignal.any([options.signal, children.signal]);
  const pending = new Set<Promise<ActionToolResult>>();
  let approved: string | undefined;
  let busy = false;
  let delivered: ActionToolResult | undefined;
  const attempts = { review_action: 0, deliver_action: 0 };
  const invoke = async (name: ActionToolName): Promise<ActionToolResult> => {
    signal.throwIfAborted();
    if (busy) return { ok: false, error: "Another Actions tool is running. Wait for its result." };
    if (delivered) return delivered;
    if (attempts[name] >= 3) return { ok: false, error: "Actions tool attempt limit reached. Report the unresolved failure; do not bypass review or delivery." };
    attempts[name] += 1;
    busy = true;
    try {
      if (name === "review_action") {
        approved = undefined;
        const snapshot = options.snapshot();
        const verdict = await options.review(signal);
        signal.throwIfAborted();
        if (options.snapshot() !== snapshot) throw new Error("The review target changed. Review the current commit again.");
        if (verdict.status === "PASS") approved = snapshot;
        return { ok: verdict.status === "PASS", verdict };
      }
      if (!approved) throw new Error("Delivery requires PASS for the current clean branch and base. Call review_action again.");
      if (options.assertDeliveryTarget) options.assertDeliveryTarget(approved);
      else if (options.snapshot() !== approved) throw new Error("Delivery target changed. Call review_action again.");
      signal.throwIfAborted();
      const result = options.deliver();
      if (result.ok) delivered = result;
      return result;
    } catch (error) {
      signal.throwIfAborted();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      busy = false;
    }
  };
  const run = (name: ActionToolName) => {
    const result = invoke(name);
    pending.add(result);
    void result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  return {
    review_action: () => run("review_action"), deliver_action: () => run("deliver_action"),
    dispose: async () => { children.abort(); await Promise.allSettled([...pending]); },
  };
}
