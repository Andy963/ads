import { getCurrentScope, onScopeDispose, watch } from "vue";

import { finalizeStreamingOnDisconnect, mergeHistoryFromServer, normalizeTurnSemanticOrder } from "../lib/chat_sync";
import { ingestCommandActivity, ingestExploredActivity } from "../lib/live_activity";

import type { AppContext, ChatItem, IncomingImage, ProjectRuntime, QueuedPrompt } from "./controller";
import { createExecuteActions } from "./chatExecute";
import { findFirstLiveIndex, findLastLiveIndex, isLiveMessageId, LIVE_ACTIVITY_ID, LIVE_MESSAGE_IDS, LIVE_STEP_ID } from "./chatLive";
export { LIVE_ACTIVITY_ID, LIVE_MESSAGE_IDS, LIVE_STEP_ID } from "./chatLive";
import { createStreamingActions } from "./chatStreaming";
import {
  createOutboxStore,
  isEmptyOutboxSnapshot,
  isUnsentTurnRetry,
  legacyPendingPromptStorageKey,
  outboxStorageKey,
  type OutboxSnapshot,
  type PersistedPrompt,
} from "./outbox";
import { RETIRED_ACOPILOT_WIRE_SESSION_IDS, WIRE_ACOPILOT_SESSION_ID } from "../lib/laneWire";
import { TURN_FAILURE_CARD_PREFIX } from "../lib/turnFailure";

type UploadedImageAttachment = {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
};

export function createChatActions(ctx: AppContext) {
  const {
    runtimeOrActive,
    maxExecutePreviewLines,
    maxRecentCommands,
    maxTurnCommands,
  } = ctx;
  const { randomId, randomUuid } = ctx;

  const guessImageFilename = (attachment: IncomingImage, contentType: string): string => {
    const name = String(attachment.name ?? "").trim();
    if (name) return name;
    const t = String(attachment.mime ?? contentType ?? "").trim().toLowerCase();
    if (t === "image/png") return "pasted.png";
    if (t === "image/webp") return "pasted.webp";
    if (t === "image/jpeg" || t === "image/jpg") return "pasted.jpg";
    if (t === "image/gif") return "pasted.gif";
    if (t === "image/bmp") return "pasted.bmp";
    if (t === "image/svg+xml") return "pasted.svg";
    return "pasted.bin";
  };

  const uploadPromptImages = async (args: {
    workspaceRoot: string;
    images: IncomingImage[];
    isCurrent: () => boolean;
  }): Promise<UploadedImageAttachment[]> => {
    const workspaceRoot = String(args.workspaceRoot ?? "").trim();
    const images = Array.isArray(args.images) ? args.images : [];
    if (images.length === 0) return [];

    const uploadUrl = workspaceRoot
      ? `/api/attachments/images?workspace=${encodeURIComponent(workspaceRoot)}`
      : "/api/attachments/images";
    const results: UploadedImageAttachment[] = [];

    for (const img of images) {
      if (!args.isCurrent()) return results;
      const dataUrl = String(img.data ?? "").trim();
      if (!dataUrl) {
        continue;
      }
      const blob = await fetch(dataUrl)
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      if (!args.isCurrent()) return results;
      if (!blob || blob.size <= 0) {
        continue;
      }
      const form = new FormData();
      form.append("file", blob, guessImageFilename(img, blob.type));
      const res = await fetch(uploadUrl, { method: "POST", body: form, credentials: "include" });
      const text = await res.text().catch(() => "");
      const parseErrorMessage = (): string => {
        try {
          const obj = JSON.parse(text) as { error?: unknown };
          const msg = String(obj?.error ?? "").trim();
          return msg || `HTTP ${res.status}`;
        } catch {
          return text.trim() || `HTTP ${res.status}`;
        }
      };
      if (!res.ok) {
        throw new Error(parseErrorMessage());
      }
      try {
        const parsed = JSON.parse(text) as UploadedImageAttachment;
        if (!parsed?.id || !parsed?.url) {
          throw new Error("Invalid JSON response");
        }
        results.push(parsed);
      } catch (error) {
        throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return results;
  };

  const formatPromptTextWithAttachments = (text: string, attachments: UploadedImageAttachment[]): string => {
    const base = String(text ?? "").trim();
    const list = Array.isArray(attachments) ? attachments : [];
    if (list.length === 0) return base;
    const imgs = list.map((a, idx) => `![attachment ${idx + 1}](${a.url})`).join("\n");
    if (!base) return imgs;
    return `${base}\n\n${imgs}`;
  };

  const outbox = createOutboxStore();
  type OutboxBinding = { key: string; stop: () => void };
  const outboxBindings = new Map<ProjectRuntime, OutboxBinding>();
  const outboxGenerations = new WeakMap<ProjectRuntime, number>();
  const sendingQueuedPromptIds = new WeakMap<ProjectRuntime, Set<string>>();
  let outboxDisposed = false;
  /** Set while a sibling tab's snapshot is being applied, so we don't echo it back. */
  let applyingRemoteOutbox = false;

  const disposeOutboxBindings = (): void => {
    for (const binding of outboxBindings.values()) binding.stop();
    outboxBindings.clear();
    outbox.close();
  };
  if (ctx.accountGeneration) watch(ctx.accountGeneration, disposeOutboxBindings, { flush: "sync" });
  if (getCurrentScope()) onScopeDispose(() => {
    outboxDisposed = true;
    disposeOutboxBindings();
  });

  const outboxKeyFor = (rt: ProjectRuntime): string => {
    if (outboxDisposed) return "";
    const generation = ctx.accountGeneration?.value ?? 0;
    if (!outboxGenerations.has(rt)) outboxGenerations.set(rt, generation);
    if (outboxGenerations.get(rt) !== generation) return "";
    const sessionId = String(rt.projectSessionId ?? "").trim();
    return sessionId ? outboxStorageKey(sessionId, rt.chatSessionId) : "";
  };

  // Reads fall back to the retired wire-id keys (newest first) so an outbox
  // persisted by an older release is not lost; the next write lands on the
  // canonical key.
  const readOutboxFor = (rt: ProjectRuntime): OutboxSnapshot => {
    const key = outboxKeyFor(rt);
    if (!key) return { pending: null, sent: [], queued: [], dismissed: [], consumed: [] };
    const snapshot = outbox.read(key);
    if (!isEmptyOutboxSnapshot(snapshot) || rt.chatSessionId !== WIRE_ACOPILOT_SESSION_ID) {
      return snapshot;
    }
    const sessionId = String(rt.projectSessionId ?? "").trim();
    if (!sessionId) return snapshot;
    for (const retiredId of RETIRED_ACOPILOT_WIRE_SESSION_IDS) {
      const fallback = outbox.read(outboxStorageKey(sessionId, retiredId));
      if (!isEmptyOutboxSnapshot(fallback)) return fallback;
    }
    return snapshot;
  };

  const toPersistedPrompt = (prompt: QueuedPrompt): PersistedPrompt | null => {
    // Images are in-memory blobs; a prompt carrying them cannot be restored later.
    if (prompt.images.length > 0) return null;
    const clientMessageId = String(prompt.clientMessageId ?? "").trim();
    if (!clientMessageId) return null;
    return {
      clientMessageId,
      text: prompt.text,
      createdAt: prompt.createdAt,
      ...(prompt.agentId ? { agentId: prompt.agentId } : {}),
      ...(prompt.model ? { model: prompt.model } : {}),
      ...(prompt.modelReasoningEffort ? { modelReasoningEffort: prompt.modelReasoningEffort } : {}),
      ...(prompt.replayIncomplete ? { replayIncomplete: true } : {}),
      ...(prompt.retryOriginal ? { retryOriginal: true } : {}),
    };
  };

  const DISMISSED_LIMIT = 500;

  // The set only ever grows, and a dismissal is only useful while its client id
  // is still around, so cap it. Set iteration is insertion-ordered, which makes
  // the leading entries the oldest.
  const pruneDismissals = (dismissed: Set<string>): void => {
    if (dismissed.size <= DISMISSED_LIMIT) return;
    for (const clientMessageId of dismissed) {
      if (dismissed.size <= DISMISSED_LIMIT) break;
      dismissed.delete(clientMessageId);
    }
  };

  const persistOutbox = (
    rt: ProjectRuntime,
    pending?: PersistedPrompt | null,
    sent?: PersistedPrompt[],
    cancelIntents?: string[],
  ): void => {
    if (applyingRemoteOutbox) return;
    const key = outboxKeyFor(rt);
    if (!key) return;
    const binding = outboxBindings.get(rt);
    if (binding && binding.key !== key) return;
    const current = readOutboxFor(rt);
    const nextPending = pending === undefined ? current.pending : pending;
    const nextSent = sent === undefined ? current.sent : sent;
    const dismissed = rt.dismissedPromptIds ?? new Set<string>();
    const consumed = rt.consumedPromptIds ?? new Set<string>();
    const cancelled = rt.cancelledPromptIds ?? new Set<string>();
    const retired = rt.retiredPromptIds ?? new Set<string>();
    const isDismissed = (prompt: { clientMessageId?: unknown }): boolean =>
      dismissed.has(String(prompt.clientMessageId ?? "").trim());
    const isConsumed = (prompt: { clientMessageId?: unknown }): boolean =>
      consumed.has(String(prompt.clientMessageId ?? "").trim())
      || cancelled.has(String(prompt.clientMessageId ?? "").trim())
      || retired.has(String(prompt.clientMessageId ?? "").trim());
    outbox.write(key, {
      pending: nextPending && !isDismissed(nextPending) && !isConsumed(nextPending) ? nextPending : null,
      sent: nextSent.filter((prompt) => !isDismissed(prompt) && !isConsumed(prompt)),
      dismissed: Array.from(dismissed),
      consumed: Array.from(consumed),
      cancelled: Array.from(cancelled),
      retired: Array.from(retired),
      cancelIntents: cancelIntents ?? current.cancelIntents ?? [],
      queued: rt.queuedPrompts.value
        .filter((prompt) => !isDismissed(prompt) && !isConsumed(prompt))
        .filter((prompt) => prompt.deliveryStatus === "offline" || prompt.restoredFromStorage || prompt.replayIncomplete)
        .map(toPersistedPrompt)
        .filter(Boolean) as PersistedPrompt[],
    });
  };

  const requestPromptCancellation = (rt: ProjectRuntime, clientMessageId: string): void => {
    const id = String(clientMessageId ?? "").trim();
    if (!id) return;
    const socket = rt.ws as {
      cancelPrompt?: (promptId: string) => boolean;
      send?: (type: string, payload?: unknown, options?: { clientMessageId?: string }) => boolean;
    } | null;
    if (typeof socket?.cancelPrompt === "function") {
      socket.cancelPrompt(id);
      return;
    }
    socket?.send?.("cancel_prompt", undefined, { clientMessageId: id });
  };

  const applyPersistedSuppressions = (rt: ProjectRuntime, snapshot: OutboxSnapshot): void => {
    const dismissed = rt.dismissedPromptIds ?? new Set<string>();
    for (const clientMessageId of [...snapshot.dismissed, ...(snapshot.cancelIntents ?? [])]) {
      if (clientMessageId) {
        const wasDismissed = dismissed.has(clientMessageId);
        dismissed.add(clientMessageId);
        if (!wasDismissed && !rt.promptReconciliationPending) requestPromptCancellation(rt, clientMessageId);
      }
    }
    rt.dismissedPromptIds = dismissed;
    pruneDismissals(dismissed);
    const consumed = rt.consumedPromptIds ?? new Set<string>();
    for (const prompt of snapshot.queued) {
      if (prompt.replayIncomplete && !prompt.sentAwaitingAck && !snapshot.consumed?.includes(prompt.clientMessageId)) {
        consumed.delete(prompt.clientMessageId);
      }
    }
    for (const clientMessageId of snapshot.consumed ?? []) {
      if (clientMessageId) consumed.add(clientMessageId);
    }
    rt.consumedPromptIds = consumed;
    const cancelled = rt.cancelledPromptIds ?? new Set<string>();
    for (const clientMessageId of snapshot.cancelled ?? []) {
      if (clientMessageId) cancelled.add(clientMessageId);
    }
    rt.cancelledPromptIds = cancelled;
    const retired = rt.retiredPromptIds ?? new Set<string>();
    for (const clientMessageId of snapshot.retired ?? []) {
      if (clientMessageId) retired.add(clientMessageId);
    }
    rt.retiredPromptIds = retired;
    const before = rt.queuedPrompts.value.length;
    const after = rt.queuedPrompts.value.filter(
      (prompt) => !dismissed.has(prompt.clientMessageId)
        && !consumed.has(prompt.clientMessageId)
        && !cancelled.has(prompt.clientMessageId)
        && !retired.has(prompt.clientMessageId),
    );
    if (after.length !== before) rt.queuedPrompts.value = after;
  };

  const applyRemoteOutbox = (rt: ProjectRuntime, snapshot: OutboxSnapshot): void => {
    applyPersistedSuppressions(rt, snapshot);
    if (rt.promptReconciliationPending) return;
    const dismissed = rt.dismissedPromptIds ?? new Set<string>();
    const consumed = rt.consumedPromptIds ?? new Set<string>();
    const cancelled = rt.cancelledPromptIds ?? new Set<string>();
    const retired = rt.retiredPromptIds ?? new Set<string>();
    const isSuppressed = (clientMessageId: string): boolean =>
      dismissed.has(clientMessageId)
      || consumed.has(clientMessageId)
      || cancelled.has(clientMessageId)
      || retired.has(clientMessageId);
    // Keep prompts this tab cannot persist (image prompts) plus every card the
    // server still owns. The outbox deliberately omits acknowledged work, so
    // trusting it alone would hide queued/running/failed cards until the next
    // authoritative queue event arrived.
    const localOnly = rt.queuedPrompts.value.filter(
      (prompt) => !isSuppressed(prompt.clientMessageId)
        && (prompt.images.length > 0 || prompt.serverQueueTracked === true),
    );
    const shared = [...snapshot.sent, ...snapshot.queued]
      .filter((prompt) => !isSuppressed(prompt.clientMessageId))
      .map((prompt) => {
      const existing = rt.queuedPrompts.value.find((q) => q.clientMessageId === prompt.clientMessageId);
      return existing ?? ({
        id: randomId("q"),
        clientMessageId: prompt.clientMessageId,
        text: prompt.text,
        images: [],
        createdAt: prompt.createdAt,
        agentId: String(prompt.agentId ?? ""),
        model: String(prompt.model ?? ""),
        modelReasoningEffort: String(prompt.modelReasoningEffort ?? prompt.model_reasoning_effort ?? ""),
        ...(prompt.replayIncomplete ? { replayIncomplete: true } : {}),
        ...(prompt.retryOriginal ? { retryOriginal: true } : {}),
        ...(prompt.sentAwaitingAck ? { replayIncomplete: true, restoredFromStorage: true } : {}),
      } satisfies QueuedPrompt);
      });
    // A delayed broadcast can still mention an id this tab already tracks (or the
    // same id twice). Merging blindly would render two cards for one prompt, with
    // duplicate keys and two competing retry/remove targets.
    const merged = new Map<string, ProjectRuntime["queuedPrompts"]["value"][number]>();
    for (const prompt of [...shared, ...localOnly]) {
      if (!merged.has(prompt.clientMessageId)) merged.set(prompt.clientMessageId, prompt);
    }
    const next = Array.from(merged.values());
    const unchanged =
      next.length === rt.queuedPrompts.value.length &&
      next.every((prompt, index) => prompt.clientMessageId === rt.queuedPrompts.value[index]?.clientMessageId);
    if (unchanged) return;
    rt.queuedPrompts.value = next;
  };

  /**
   * Start persisting this runtime's queue and following sibling tabs.
   *
   * Bound lazily because the storage key needs `projectSessionId`, which is only
   * known once the lane has been resolved.
   */
  const ensureOutboxBinding = (rt: ProjectRuntime): void => {
    const key = outboxKeyFor(rt);
    const previous = outboxBindings.get(rt);
    if (previous?.key === key) return;
    previous?.stop();
    outboxBindings.delete(rt);
    if (!key) return;
    if (previous) {
      // Runtime identities are plain fields, not Vue refs. Dispose the old
      // watcher BEFORE clearing state and write only to its captured owner key.
      const snapshot = outbox.read(previous.key);
      const retired = new Set([
        ...(snapshot.retired ?? []), ...(rt.retiredPromptIds ?? []),
        snapshot.pending?.clientMessageId, rt.pendingAckClientMessageId,
        ...snapshot.sent.map((prompt) => prompt.clientMessageId),
        ...snapshot.queued.map((prompt) => prompt.clientMessageId),
        ...rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId),
        ...(snapshot.cancelIntents ?? []),
      ].filter((id): id is string => Boolean(id)));
      outbox.write(previous.key, { ...snapshot, pending: null, sent: [], queued: [], retired: [...retired] });
      rt.queuedPrompts.value = [];
      rt.pendingAckClientMessageId = null;
      rt.promptReconciliationPending = false;
      rt.promptReconciliationIds = undefined;
      rt.dismissedPromptIds = new Set();
      rt.consumedPromptIds = new Set();
      rt.cancelledPromptIds = new Set();
      rt.retiredPromptIds = new Set();
      sendingQueuedPromptIds.delete(rt);
    }
    const binding: OutboxBinding = { key, stop: () => {} };
    outboxBindings.set(rt, binding);
    // The legacy pending key of the current wire id never existed for the
    // Acopilot lane: older releases wrote it under the retired spellings.
    const legacyPendingIds = rt.chatSessionId === WIRE_ACOPILOT_SESSION_ID
      ? RETIRED_ACOPILOT_WIRE_SESSION_IDS
      : [rt.chatSessionId];
    for (const legacyId of legacyPendingIds) {
      outbox.migrateLegacyPending({
        key,
        legacyKey: legacyPendingPromptStorageKey(rt.projectSessionId, legacyId),
      });
    }
    // Restoring has to re-filter too: a reload can render the queue before this
    // tab binds its outbox, and a suppressed card must stay gone.
    applyPersistedSuppressions(rt, readOutboxFor(rt));
    // `sync` so a queue change survives an immediate tab close.
    const ownsKey = (): boolean => outboxBindings.get(rt) === binding && outboxKeyFor(rt) === key;
    const stopQueue = watch(rt.queuedPrompts, () => {
      if (!ownsKey()) return;
      persistOutbox(rt);
    }, { flush: "sync" });
    const unsubscribe = outbox.subscribe((changedKey, snapshot) => {
      if (changedKey !== key || !ownsKey()) return;
      // Suppression updates also mutate the queue. Keep them inside the echo
      // guard so a stale broadcast cannot overwrite the durable snapshot.
      const wasApplying = applyingRemoteOutbox;
      applyingRemoteOutbox = true;
      try {
        applyRemoteOutbox(rt, snapshot);
      } finally {
        applyingRemoteOutbox = wasApplying;
      }
    });
    binding.stop = () => { stopQueue(); unsubscribe(); };
  };

  const savePendingPrompt = (rt: ProjectRuntime, prompt: QueuedPrompt): void => {
    if (!rt.projectSessionId) return;
    ensureOutboxBinding(rt);
    persistOutbox(rt, toPersistedPrompt(prompt));
  };

  const saveSentPrompt = (rt: ProjectRuntime, prompt: QueuedPrompt): void => {
    if (!rt.projectSessionId) return;
    ensureOutboxBinding(rt);
    const persisted = toPersistedPrompt(prompt);
    if (!persisted) return;
    persisted.sentAwaitingAck = true;
    const current = readOutboxFor(rt);
    persistOutbox(
      rt,
      current.pending,
      [...current.sent.filter((entry) => entry.clientMessageId !== persisted.clientMessageId), persisted],
    );
  };

  const clearPendingPrompt = (rt: ProjectRuntime, clientMessageId?: string): PersistedPrompt | null => {
    if (!rt.projectSessionId) return null;
    const id = String(clientMessageId ?? "").trim();
    const current = readOutboxFor(rt);
    if (!id) {
      persistOutbox(rt, null, []);
      return null;
    }
    const acknowledged = current.sent.find((entry) => entry.clientMessageId === id)
      ?? (current.pending?.clientMessageId === id ? current.pending : null);
    persistOutbox(
      rt,
      current.pending?.clientMessageId === id ? null : current.pending,
      current.sent.filter((entry) => entry.clientMessageId !== id),
    );
    return acknowledged;
  };

  const readPendingPrompt = (rt: ProjectRuntime): PersistedPrompt | null => {
    if (!rt.projectSessionId) return null;
    ensureOutboxBinding(rt);
    return readOutboxFor(rt).pending;
  };

  const clearPendingPromptReplayState = (rt: ProjectRuntime): void => {
    const pendingIds = new Set<string>();
    const ackClientMessageId = String(rt.pendingAckClientMessageId ?? "").trim();
    if (ackClientMessageId) {
      pendingIds.add(ackClientMessageId);
    }
    const storedClientMessageId = String(readPendingPrompt(rt)?.clientMessageId ?? "").trim();
    if (storedClientMessageId) {
      pendingIds.add(storedClientMessageId);
    }
    for (const sent of readOutboxFor(rt).sent) {
      pendingIds.add(sent.clientMessageId);
    }
    if (pendingIds.size > 0) {
      rt.queuedPrompts.value = rt.queuedPrompts.value.filter((q) => !pendingIds.has(String(q.clientMessageId ?? "").trim()));
    }
    rt.pendingAckClientMessageId = null;
    clearPendingPrompt(rt);
  };

  const restorePendingPrompt = (rt: ProjectRuntime, beforeReconciliation = false): void => {
    if (rt.promptReconciliationPending && !beforeReconciliation) return;
    if (!rt.projectSessionId) return;
    ensureOutboxBinding(rt);
    const snapshot = readOutboxFor(rt);
    const queuedByClientMessageId = new Set(
      rt.queuedPrompts.value.map((q) => String(q.clientMessageId ?? "").trim()),
    );
    const dismissed = rt.dismissedPromptIds ?? new Set<string>();
    const consumed = rt.consumedPromptIds ?? new Set<string>();
    const cancelled = rt.cancelledPromptIds ?? new Set<string>();
    const retired = rt.retiredPromptIds ?? new Set<string>();
    const isSuppressed = (clientMessageId: string): boolean =>
      dismissed.has(clientMessageId)
      || consumed.has(clientMessageId)
      || cancelled.has(clientMessageId)
      || retired.has(clientMessageId);

    const restored: QueuedPrompt[] = [];
    const stored = snapshot.pending;
    if (stored) {
      const clientMessageId = String(stored.clientMessageId ?? "").trim();
      // The pending prompt was already sent, so it is replayed with the
      // `replay_incomplete` marker rather than treated as a fresh queue entry.
      if (clientMessageId && !isSuppressed(clientMessageId) && !queuedByClientMessageId.has(clientMessageId)) {
        queuedByClientMessageId.add(clientMessageId);
        restored.push({
          id: randomId("q"),
          clientMessageId,
          text: String(stored.text ?? ""),
          images: [],
          createdAt: Number(stored.createdAt) || Date.now(),
          agentId: String(stored.agentId ?? "").trim(),
          model: String(stored.model ?? "").trim(),
          modelReasoningEffort: String(stored.modelReasoningEffort ?? stored.model_reasoning_effort ?? "").trim(),
          restoredFromStorage: true,
          ...(stored.retryOriginal ? { retryOriginal: true } : {}),
        });
      }
    }

    // Prompts still waiting their turn were never sent; they requeue as-is.
    for (const queued of [...snapshot.sent, ...snapshot.queued]) {
      const clientMessageId = String(queued.clientMessageId ?? "").trim();
      if (!clientMessageId || queuedByClientMessageId.has(clientMessageId)) continue;
      // Storage still holding a card the user removed is the normal case, not
      // an exception: honouring the dismissal here is what makes removal stick
      // across a restart instead of only for the lifetime of one page.
      if (isSuppressed(clientMessageId)) continue;
      queuedByClientMessageId.add(clientMessageId);
      restored.push({
        id: randomId("q"),
        clientMessageId,
        text: String(queued.text ?? ""),
        images: [],
        createdAt: Number(queued.createdAt) || Date.now(),
        agentId: String(queued.agentId ?? "").trim(),
        model: String(queued.model ?? "").trim(),
        modelReasoningEffort: String(queued.modelReasoningEffort ?? queued.model_reasoning_effort ?? "").trim(),
        ...(queued.replayIncomplete || queued.sentAwaitingAck ? { replayIncomplete: true } : {}),
        ...(queued.retryOriginal ? { retryOriginal: true } : {}),
        ...(queued.sentAwaitingAck ? { restoredFromStorage: true } : {}),
      });
    }

    if (restored.length === 0) return;
    rt.queuedPrompts.value = [...restored, ...rt.queuedPrompts.value];
  };

  const reconcilePromptOutbox = (
    rt: ProjectRuntime,
    socket: { send: (type: string, payload?: unknown) => boolean | void } | null = rt.ws,
  ): void => {
    ensureOutboxBinding(rt);
    rt.promptReconciliationPending = true;
    // Hydrate before bootstrap frames arrive, while the reconciliation gate
    // still prevents sending. Otherwise cold-start retries exist only on disk.
    restorePendingPrompt(rt, true);
    const snapshot = readOutboxFor(rt);
    const clientMessageIds = new Set<string>();
    for (const prompt of [snapshot.pending, ...snapshot.sent, ...snapshot.queued]) {
      const id = String(prompt?.clientMessageId ?? "").trim();
      if (id) clientMessageIds.add(id);
    }
    for (const prompt of rt.queuedPrompts.value) {
      const id = String(prompt.clientMessageId ?? "").trim();
      if (id) clientMessageIds.add(id);
    }
    const pendingAckId = String(rt.pendingAckClientMessageId ?? "").trim();
    if (pendingAckId) clientMessageIds.add(pendingAckId);
    const terminal = new Set([
      ...(snapshot.consumed ?? []),
      ...(snapshot.cancelled ?? []),
      ...(snapshot.retired ?? []),
    ]);
    const cancelClientMessageIds = new Set([
      ...(snapshot.cancelIntents ?? []),
      ...snapshot.dismissed,
    ]);
    for (const id of [...cancelClientMessageIds]) {
      if (terminal.has(id)) cancelClientMessageIds.delete(id);
      else clientMessageIds.add(id);
    }
    if (clientMessageIds.size === 0 && cancelClientMessageIds.size === 0) {
      rt.promptReconciliationPending = false;
      rt.promptReconciliationIds = undefined;
      return;
    }
    rt.promptReconciliationIds = clientMessageIds;
    const sent = socket?.send("prompt_reconcile", {
      clientMessageIds: Array.from(clientMessageIds),
      cancelClientMessageIds: Array.from(cancelClientMessageIds),
    });
    if (!socket || sent === false) {
      if (socket) rt.wsError.value = "Prompt reconciliation could not be sent";
      return;
    }
    if (sent === undefined) {
      rt.promptReconciliationPending = false;
      rt.promptReconciliationIds = undefined;
      restorePendingPrompt(rt);
    }
  };

  const preservePromptMessage = (
    rt: ProjectRuntime,
    clientMessageId: string,
    snapshot: OutboxSnapshot,
  ): void => {
    if (rt.messages.value.some((message) => message.id === clientMessageId && message.role === "user")) return;
    const prompt = rt.queuedPrompts.value.find((entry) => entry.clientMessageId === clientMessageId)
      ?? (snapshot.pending?.clientMessageId === clientMessageId ? snapshot.pending : null)
      ?? snapshot.sent.find((entry) => entry.clientMessageId === clientMessageId)
      ?? snapshot.queued.find((entry) => entry.clientMessageId === clientMessageId)
      ?? null;
    const content = String(prompt?.text ?? "");
    if (!content.trim()) return;
    const createdAt = Number(prompt?.createdAt);
    pushMessageBeforeLive({
      id: clientMessageId,
      role: "user",
      kind: "text",
      content,
      ...(Number.isFinite(createdAt) && createdAt > 0 ? { ts: Math.floor(createdAt) } : {}),
    }, rt);
  };

  const applyPromptReconciliation = (
    rt: ProjectRuntime,
    identities: Array<{ clientMessageId: string; disposition: string; retryable?: boolean }>,
  ): void => {
    const returnedIds = new Set(identities.map((identity) => String(identity.clientMessageId ?? "").trim()).filter(Boolean));
    const missingIds = Array.from(rt.promptReconciliationIds ?? []).filter((id) => !returnedIds.has(id));
    if (missingIds.length > 0) {
      rt.wsError.value = "Prompt reconciliation returned an incomplete identity set";
      return;
    }
    const settledIds = new Set<string>();
    const terminalIds = new Set<string>();
    const current = readOutboxFor(rt);
    for (const identity of identities) {
      const id = String(identity.clientMessageId ?? "").trim();
      if (!id) continue;
      if (identity.disposition === "consumed" && identity.retryable === true
        && rt.queuedPrompts.value.some((prompt) => prompt.clientMessageId === id && isUnsentTurnRetry(prompt))) {
        continue;
      }
      if (["consumed", "cancelled", "obsolete"].includes(identity.disposition)) {
        settledIds.add(id);
      }
      if (identity.disposition === "consumed") {
        preservePromptMessage(rt, id, current);
        (rt.consumedPromptIds ??= new Set()).add(id);
        rt.cancelledPromptIds?.delete(id);
        rt.retiredPromptIds?.delete(id);
        terminalIds.add(id);
      } else if (identity.disposition === "cancelled") {
        if (!rt.consumedPromptIds?.has(id)) (rt.cancelledPromptIds ??= new Set()).add(id);
        terminalIds.add(id);
      } else if (identity.disposition === "obsolete") {
        if (!rt.consumedPromptIds?.has(id) && !rt.cancelledPromptIds?.has(id)) {
          (rt.retiredPromptIds ??= new Set()).add(id);
        }
        terminalIds.add(id);
      }
      if (terminalIds.has(id)) rt.dismissedPromptIds?.delete(id);
    }
    if (terminalIds.size > 0) {
      rt.queuedPrompts.value = rt.queuedPrompts.value.filter(
        (prompt) => !terminalIds.has(prompt.clientMessageId),
      );
    }
    if (rt.pendingAckClientMessageId && settledIds.has(rt.pendingAckClientMessageId)) {
      rt.pendingAckClientMessageId = null;
    }
    rt.promptReconciliationPending = false;
    rt.promptReconciliationIds = undefined;
    ensureOutboxBinding(rt);
    persistOutbox(
      rt,
      current.pending && !settledIds.has(current.pending.clientMessageId) ? current.pending : null,
      current.sent.filter((prompt) => !settledIds.has(prompt.clientMessageId)),
      current.cancelIntents,
    );
    restorePendingPrompt(rt);
    void flushQueuedPrompts(rt);
  };

  const trimChatItems = (items: ChatItem[]): ChatItem[] => {
    const existing = Array.isArray(items) ? items : [];
    const liveById = new Map<string, ChatItem>();
    for (const liveId of LIVE_MESSAGE_IDS) {
      const msg = existing.find((m) => m.id === liveId) ?? null;
      if (msg) liveById.set(liveId, msg);
    }

    // Keep the complete conversation in memory. The message list owns the DOM
    // window, so retaining history here does not require mounting every item.
    const trimmed = existing.filter((m) => !isLiveMessageId(m.id));
    const liveBlock = LIVE_MESSAGE_IDS.map((id) => liveById.get(id)).filter(Boolean) as ChatItem[];
    if (liveBlock.length === 0) {
      return trimmed;
    }

    let insertAt = trimmed.length;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const m = trimmed[i]!;
      if (m.role === "assistant" && m.streaming) {
        insertAt = i;
        break;
      }
    }
    for (let i = 0; i < insertAt; i++) {
      if (trimmed[i]!.kind === "execute") {
        insertAt = i;
        break;
      }
    }

    return [...trimmed.slice(0, insertAt), ...liveBlock, ...trimmed.slice(insertAt)];
  };

  const setMessages = (items: ChatItem[], rt?: ProjectRuntime): void => {
    runtimeOrActive(rt).messages.value = trimChatItems(normalizeTurnSemanticOrder(items));
  };

  const pushMessageBeforeLive = (item: Omit<ChatItem, "id"> & { id?: string }, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    const liveIndex = findFirstLiveIndex(existing);
    const explicitId = String(item.id ?? "").trim();
    const next = { ...item, id: explicitId || randomId("msg") };
    if (liveIndex < 0) {
      setMessages([...existing, next], state);
      return;
    }
    setMessages([...existing.slice(0, liveIndex), next, ...existing.slice(liveIndex)], state);
  };

  const pushRecentCommand = (command: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const trimmed = String(command ?? "").trim();
    if (!trimmed) return;
    state.turnCommandCount += 1;
    const turn = [...state.turnCommands, trimmed];
    state.turnCommands = turn.slice(Math.max(0, turn.length - maxTurnCommands));
    const recent = [...state.recentCommands.value, trimmed];
    state.recentCommands.value = recent.slice(Math.max(0, recent.length - maxRecentCommands));
  };

  const resetConversation = (rt: ProjectRuntime, notice: string, keepLatestTurn = true): void => {
    const existing = rt.messages.value.slice();
    const withoutLive = existing.filter((m) => !isLiveMessageId(m.id));
    const tail = (() => {
      if (!keepLatestTurn) return [];
      for (let i = withoutLive.length - 1; i >= 0; i--) {
        if (withoutLive[i]!.role === "user") return withoutLive.slice(i);
      }
      return [];
    })();

    rt.recentCommands.value = [];
    rt.turnCommands = [];
    rt.turnCommandCount = 0;
    rt.executePreviewByKey.clear();
    rt.executeOrder = [];
    rt.seenCommandIds.clear();
    rt.pendingImages.value = [];
    rt.turnInFlight = false;
    rt.turnHasPatch = false;
    clearStepLive(rt);

    const normalizedNotice = notice.trim();
    if (normalizedNotice) {
      rt.laneStatus.value = { kind: "info", message: normalizedNotice };
    } else {
      rt.laneStatus.value = null;
    }
    setMessages([...tail], rt);
  };

  const recordChatClear = (reason: "thread_reset", source: string): void => {
    try {
      console.info("[ads][chat_clear]", { reason, source, ts: Date.now() });
    } catch {
      // ignore
    }
  };

  const resolveClearHistoryPayload = (rt: ProjectRuntime, payload: unknown): unknown => {
    const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};
    const requestedScope = String(payloadRecord.scope ?? "").trim().toLowerCase();
    const chatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    if (requestedScope === "shared" && chatSessionId !== WIRE_ACOPILOT_SESSION_ID) {
      return { ...payloadRecord, scope: "shared" };
    }
    return {
      ...payloadRecord,
      scope: "lane",
      sourceChatSessionId: chatSessionId,
    };
  };

  const threadReset = (
    rt: ProjectRuntime,
    params: {
      notice: string;
      warning?: string | null;
      keepLatestTurn?: boolean;
      clearBackendHistory?: boolean;
      clearHistoryPayload?: unknown;
      resetThreadId?: boolean;
      source?: string;
    },
  ): void => {
    rt.transcriptCache?.invalidate();
    rt.transcriptReady = false;
    rt.transcriptCursor = 0;
    rt.threadWarning.value = params.warning ?? null;
    // A local clear may be followed by an empty bootstrap. Keep a one-shot
    // fence for that response, but associate it with the generation that was
    // current before the reset so a newer generation can never be discarded.
    rt.ignoreNextHistory = params.clearBackendHistory === true;
    rt.ignoreNextHistoryGeneration = rt.ignoreNextHistory ? rt.laneGeneration : undefined;
    rt.resumeReplacePending = false;
    rt.inputLocked.value = false;
    resetConversation(rt, params.notice, params.keepLatestTurn ?? false);
    if (params.resetThreadId) {
      rt.activeThreadId.value = null;
    }
    if (params.clearBackendHistory) {
      rt.suppressNextClearHistoryResult = true;
      rt.ws?.clearHistory(resolveClearHistoryPayload(rt, params.clearHistoryPayload));
    }
    recordChatClear("thread_reset", params.source ?? "unknown");
  };

  const clearConversationForResume = (rt: ProjectRuntime): void => {
    rt.transcriptCache?.invalidate();
    rt.transcriptReady = false;
    rt.threadWarning.value = null;
    rt.ignoreNextHistory = false;
    rt.ignoreNextHistoryGeneration = undefined;
    rt.resumeReplacePending = true;
    rt.inputLocked.value = true;
    rt.laneStatus.value = { kind: "progress", message: "正在恢复上下文…" };
    finalizeCommandBlock(rt);
  };

  const applyResumeHistory = (serverHistory: ChatItem[], rt: ProjectRuntime): void => {
    if (!rt.resumeReplacePending) {
      applyMergedHistory(serverHistory, rt);
      return;
    }
    rt.resumeReplacePending = false;
    rt.inputLocked.value = false;
    rt.laneStatus.value = null;
    resetConversation(rt, "", false);
    rt.activeThreadId.value = null;
    finalizeCommandBlock(rt);
    applyMergedHistory(serverHistory, rt);
  };

  const cancelPendingResume = (rt: ProjectRuntime): void => {
    rt.resumeReplacePending = false;
    rt.inputLocked.value = false;
  };

  const applyStreamingDisconnectCleanup = (rt: ProjectRuntime): void => {
    const existing = rt.messages.value.slice();
    const next = finalizeStreamingOnDisconnect(existing, LIVE_STEP_ID);
    if (next.length === existing.length && next.every((m, idx) => m === existing[idx])) return;
    setMessages(next, rt);
  };

  const applyMergedHistory = (serverHistory: ChatItem[], rt: ProjectRuntime): void => {
    const next = mergeHistoryFromServer(rt.messages.value, serverHistory, LIVE_STEP_ID);
    setMessages(next, rt);
  };

  const dropEmptyAssistantPlaceholder = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.kind === "text" && m.streaming && !String(m.content ?? "").trim()) {
        setMessages([...existing.slice(0, i), ...existing.slice(i + 1)], state);
        return;
      }
      if (m.role === "assistant" && m.streaming) {
        return;
      }
    }
  };

  const hasEmptyAssistantPlaceholder = (rt?: ProjectRuntime): boolean => {
    const state = runtimeOrActive(rt);
    return state.messages.value.some((m) => m.role === "assistant" && m.kind === "text" && m.streaming && !String(m.content ?? "").trim());
  };

  const hasAssistantAfterLastUser = (rt?: ProjectRuntime): boolean => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.filter((m) => !isLiveMessageId(m.id));
    let lastUserIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i]!.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return false;
    for (let i = existing.length - 1; i > lastUserIndex; i--) {
      const m = existing[i]!;
      if (m.role === "assistant" && String(m.content ?? "").trim()) {
        return true;
      }
    }
    return false;
  };

  const { ingestCommand, commandKeyForWsEvent, upsertExecuteBlock, finalizeCommandBlock } = createExecuteActions({
    runtimeOrActive,
    setMessages,
    pushRecentCommand,
    dropEmptyAssistantPlaceholder,
    randomId,
    maxExecutePreviewLines,
    maxTurnCommands,
  });

  const {
    upsertStreamingDelta,
    replaceStreamingText,
    upsertThoughtDelta,
    upsertLiveActivity,
    clearStepLive,
    sealActiveStreamingAssistant,
  } = createStreamingActions({
    liveActivityId: LIVE_ACTIVITY_ID,
    runtimeOrActive,
    setMessages,
    dropEmptyAssistantPlaceholder,
    isLiveMessageId,
    randomId,
  });

  const markPromptTerminal = (
    rt: ProjectRuntime,
    clientMessageId: string,
    disposition: "consumed" | "cancelled" | "retired",
    options: { onlyIfTracked?: boolean } = {},
  ): void => {
    const id = String(clientMessageId ?? "").trim();
    if (!id) return;
    if (disposition === "cancelled" && rt.consumedPromptIds?.has(id)) return;
    if (disposition === "retired" && (rt.consumedPromptIds?.has(id) || rt.cancelledPromptIds?.has(id))) return;
    const snapshot = readOutboxFor(rt);
    const tracked = rt.queuedPrompts.value.some((prompt) => prompt.clientMessageId === id)
      || snapshot.pending?.clientMessageId === id
      || snapshot.sent.some((prompt) => prompt.clientMessageId === id)
      || snapshot.queued.some((prompt) => prompt.clientMessageId === id);
    if (options.onlyIfTracked && !tracked) return;
    if (disposition === "consumed") {
      const consumed = rt.consumedPromptIds ?? new Set<string>();
      consumed.add(id);
      rt.consumedPromptIds = consumed;
      rt.cancelledPromptIds?.delete(id);
      rt.retiredPromptIds?.delete(id);
    } else if (disposition === "cancelled") {
      const cancelled = rt.cancelledPromptIds ?? new Set<string>();
      cancelled.add(id);
      rt.cancelledPromptIds = cancelled;
      rt.retiredPromptIds?.delete(id);
    } else {
      const retired = rt.retiredPromptIds ?? new Set<string>();
      retired.add(id);
      rt.retiredPromptIds = retired;
    }
    rt.dismissedPromptIds?.delete(id);
    rt.queuedPrompts.value = rt.queuedPrompts.value.filter((prompt) => prompt.clientMessageId !== id);
    ensureOutboxBinding(rt);
    persistOutbox(rt);
  };

  const markPromptConsumed = (
    rt: ProjectRuntime,
    clientMessageId: string,
    options: { onlyIfTracked?: boolean } = {},
  ): void => markPromptTerminal(rt, clientMessageId, "consumed", options);

  const markPromptCancelled = (rt: ProjectRuntime, clientMessageId: string): void =>
    markPromptTerminal(rt, clientMessageId, "cancelled");

  const markPromptRetired = (rt: ProjectRuntime, clientMessageId: string): void =>
    markPromptTerminal(rt, clientMessageId, "retired");

  const dismissPromptByClientMessageId = (
    rt: ProjectRuntime,
    clientMessageId: string,
    options: { notifyServer?: boolean } = {},
  ): void => {
    const id = String(clientMessageId ?? "").trim();
    if (!id) return;
    const state = runtimeOrActive(rt);
    const dismissed = state.dismissedPromptIds ?? new Set<string>();
    dismissed.add(id);
    state.dismissedPromptIds = dismissed;
    pruneDismissals(dismissed);
    const consumed = state.consumedPromptIds ?? new Set<string>();
    const cancelled = state.cancelledPromptIds ?? new Set<string>();
    const retired = state.retiredPromptIds ?? new Set<string>();
    const current = readOutboxFor(state);
    const cancelIntents = new Set(current.cancelIntents ?? []);
    if (!consumed.has(id) && !cancelled.has(id) && !retired.has(id)) cancelIntents.add(id);
    state.queuedPrompts.value = state.queuedPrompts.value.filter((prompt) => prompt.clientMessageId !== id);
    ensureOutboxBinding(state);
    persistOutbox(state, undefined, undefined, Array.from(cancelIntents));
    if (options.notifyServer !== false && cancelIntents.has(id)) requestPromptCancellation(state, id);
  };

  const removeQueuedPrompt = (id: string, rt?: ProjectRuntime): void => {
    const target = String(id ?? "").trim();
    if (!target) return;
    const state = runtimeOrActive(rt);
    const removed = state.queuedPrompts.value.find((q) => q.id === target);
    if (!removed) return;
    const clientMessageId = String(removed.clientMessageId ?? "").trim();
    state.queuedPrompts.value = state.queuedPrompts.value.filter((q) => q.id !== target);
    if (clientMessageId) dismissPromptByClientMessageId(state, clientMessageId);
  };

  const retryQueuedPrompt = (id: string, rt?: ProjectRuntime): void => {
    const target = String(id ?? "").trim();
    if (!target) return;
    const state = runtimeOrActive(rt);
    const prompt = state.queuedPrompts.value.find((entry) => entry.id === target);
    if (!prompt || prompt.deliveryStatus !== "failed") return;
    ensureOutboxBinding(state);
    // A queue-card retry of a claimed or stale-generation row uses a fresh
    // identity; only an unclaimed failure in the current generation reuses
    // its identity. (The turn failure card retry is the deliberate exception:
    // it replays the original identity with `replay_incomplete`.)
    const rowGeneration = Number(prompt.queueLaneGeneration ?? 0);
    const laneGeneration = Number(state.laneGeneration ?? 0);
    const generationMoved = rowGeneration > 0 && laneGeneration > 0 && rowGeneration !== laneGeneration;
    const needsNewIdentity = generationMoved || Number(prompt.queueAttempts ?? 0) > 0;
    const clientMessageId = needsNewIdentity ? randomUuid() : prompt.clientMessageId;
    // Re-keying orphans the original durable row, and an obsolete-generation row
    // stays in the logical-lane snapshot. Retire it explicitly, otherwise the next
    // snapshot resurrects the failed card next to the retry and invites a second
    // duplicate retry.
    const dismissed = state.dismissedPromptIds ?? new Set<string>();
    state.dismissedPromptIds = dismissed;
    if (needsNewIdentity) {
      dismissed.add(prompt.clientMessageId);
      const cancelIntents = new Set(readOutboxFor(state).cancelIntents ?? []);
      cancelIntents.add(prompt.clientMessageId);
      persistOutbox(state, undefined, undefined, Array.from(cancelIntents));
      requestPromptCancellation(state, prompt.clientMessageId);
    } else {
      dismissed.delete(prompt.clientMessageId);
    }
    state.queuedPrompts.value = state.queuedPrompts.value.map((entry) =>
      entry.id === target
        ? {
          ...entry,
          clientMessageId,
          replayIncomplete: true,
          retryOriginal: !needsNewIdentity && prompt.serverQueueTracked === true,
          restoredFromStorage: true,
          deliveryStatus: state.connected.value ? "awaiting_ack" : "offline",
          serverQueueTracked: false,
          queueError: undefined,
          queueLaneGeneration: undefined,
        }
        : entry,
    );
    void flushQueuedPrompts(state);
  };

  const enqueuePrompt = (text: string, images: IncomingImage[], rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const content = String(text ?? "").trim();
    const imgs = Array.isArray(images) ? images : [];
    if (!content && imgs.length === 0) return;
    // A newly queued prompt belongs to the current lane generation. It must
    // not inherit a stale one-shot reset fence from an earlier clear.
    state.ignoreNextHistory = false;
    state.ignoreNextHistoryGeneration = undefined;
    const agentId = String(state.activeAgentId.value ?? "").trim();
    ensureOutboxBinding(state);
    state.queuedPrompts.value = [
      ...state.queuedPrompts.value,
      {
        id: randomId("q"),
        clientMessageId: randomUuid(),
        text: content,
        images: imgs,
        createdAt: Date.now(),
        agentId,
        deliveryStatus: state.connected.value ? "awaiting_ack" : "offline",
      },
    ];
    void flushQueuedPrompts(state);
  };

  const enqueueMainPrompt = (text: string, images: IncomingImage[]): void => enqueuePrompt(text, images);

  const retryPrompt = (message: ChatItem, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    if (message.kind !== "error") return;
    const existing = state.messages.value;
    const cardIndex = existing.findIndex((item) => item.id === message.id);
    if (cardIndex < 0) {
      state.laneStatus.value = { kind: "error", message: "无法重试：该失败记录已不在当前会话中，请重新发送消息。" };
      return;
    }
    // The failure card id embeds its user message id, so the retry targets the
    // turn that failed even when newer messages sit between them. The backward
    // scan stays as a fallback for cards without an embedded anchor.
    const anchoredUserId = message.id.startsWith(TURN_FAILURE_CARD_PREFIX)
      ? message.id.slice(TURN_FAILURE_CARD_PREFIX.length)
      : "";
    let userItem = anchoredUserId
      ? existing.find((item) => item.role === "user" && item.id === anchoredUserId)
      : undefined;
    if (!userItem) {
      for (let index = cardIndex - 1; index >= 0; index -= 1) {
        if (existing[index]!.role === "user") {
          userItem = existing[index]!;
          break;
        }
      }
    }
    const text = String(userItem?.content ?? "").trim();
    if (!userItem || !text) {
      state.laneStatus.value = { kind: "error", message: "无法重试：找不到该轮对应的原始消息，请重新发送。" };
      return;
    }
    ensureOutboxBinding(state);
    if (state.cancelledPromptIds?.has(userItem.id) || state.retiredPromptIds?.has(userItem.id)
      || !outbox.reactivateForRetry(outboxKeyFor(state), userItem.id)) {
      state.laneStatus.value = { kind: "error", message: "This message was cancelled or belongs to an obsolete session. Send a new message to continue." };
      return;
    }
    // Clear the failure state before re-dispatching; a new failure anchors a
    // fresh card to the retried turn instead.
    setMessages(existing.filter((item) => item.id !== message.id), state);
    state.ignoreNextHistory = false;
    state.ignoreNextHistoryGeneration = undefined;
    // The failed turn left its identity marked terminal (consumed once the
    // server claimed it, dismissed if its queue card was removed). An explicit
    // retry re-activates that identity, so drop those marks before re-sending.
    state.consumedPromptIds?.delete(userItem.id);
    state.dismissedPromptIds?.delete(userItem.id);
    const execution = userItem.execution ?? {};
    const agentId = String(execution.agentId ?? "").trim() || String(state.activeAgentId.value ?? "").trim();
    state.queuedPrompts.value = [
      ...state.queuedPrompts.value,
      {
        id: randomId("q"),
        clientMessageId: userItem.id,
        text,
        images: [],
        createdAt: Date.now(),
        ...(agentId ? { agentId } : {}),
        ...(execution.model ? { model: execution.model } : {}),
        ...(execution.modelReasoningEffort ? { modelReasoningEffort: execution.modelReasoningEffort } : {}),
        replayIncomplete: true,
        retryOriginal: true,
        deliveryStatus: state.connected.value ? "awaiting_ack" : "offline",
      },
    ];
    state.laneStatus.value = {
      kind: "progress",
      message: state.connected.value && state.ws
        ? "Retry queued. Waiting to send…"
        : "Retry queued. Waiting for the connection…",
    };
    void flushQueuedPrompts(state);
  };

  const flushQueuedPrompts = async (
    rt?: ProjectRuntime,
    options?: { preserveErrorStatus?: boolean },
  ): Promise<void> => {
    const state = runtimeOrActive(rt);
    ensureOutboxBinding(state);
    if (state.promptReconciliationPending) return;
    if (state.syncInProgress || state.awaitingBootstrapHistory) return;
    if (state.inputLocked.value && !state.queuedPrompts.value[0]?.restoredFromStorage) return;
    if (!state.connected.value) return;
    if (!state.ws) return;
    if (state.queuedPrompts.value.length === 0) return;

    const account = ctx.accountGeneration?.value;
    const binding = outboxBindings.get(state);
    const projectSessionId = state.projectSessionId;
    const chatSessionId = state.chatSessionId;
    // A connected runtime may not have a durable project identity yet. Keep
    // its in-memory send path, but fence it by the captured account/session
    // just like a persistent binding instead of inventing a storage key.
    const isCurrentScope = (): boolean =>
      !outboxDisposed && ctx.accountGeneration?.value === account &&
      outboxGenerations.get(state) === (account ?? 0) &&
      state.projectSessionId === projectSessionId && state.chatSessionId === chatSessionId &&
      outboxBindings.get(state) === binding && (!binding || outboxKeyFor(state) === binding.key);
    if (!isCurrentScope()) return;
    let sending = sendingQueuedPromptIds.get(state);
    if (!sending) {
      sending = new Set<string>();
      sendingQueuedPromptIds.set(state, sending);
    }
    const next = state.queuedPrompts.value.find((prompt) =>
      !sending.has(prompt.clientMessageId) &&
      (prompt.deliveryStatus === "offline" || prompt.deliveryStatus === "awaiting_ack" || prompt.deliveryStatus === undefined),
    );
    if (!next) return;
    sending.add(next.clientMessageId);
    const runtimeWasBusy = state.busy.value || state.turnInFlight;
    state.queuedPrompts.value = state.queuedPrompts.value.map((prompt) =>
      prompt.clientMessageId === next.clientMessageId
        ? { ...prompt, deliveryStatus: "awaiting_ack" }
        : prompt,
    );
    state.ignoreNextHistory = false;
    state.ignoreNextHistoryGeneration = undefined;
    let sendAccepted = false;

    try {
      let display = next.preparedPayload?.text ?? "";
      let promptText = next.preparedPayload?.text ?? next.text;

      if (next.images.length > 0 && !next.preparedPayload) {
        try {
          const attachments = await uploadPromptImages({
            workspaceRoot: state.workspacePath.value, images: next.images, isCurrent: isCurrentScope,
          });
          if (attachments.length > 0) {
            promptText = formatPromptTextWithAttachments(next.text, attachments);
            display = promptText;
          }
        } catch {
          // ignore: fall back to the legacy placeholder below
        }
      }

      if (!display) {
        display =
          next.text && next.images.length > 0
            ? `${next.text}\n\n[图片 x${next.images.length}]`
            : next.text
              ? next.text
              : `[图片 x${next.images.length}]`;
      }

      if (!isCurrentScope() || !state.queuedPrompts.value.some((prompt) => prompt.clientMessageId === next.clientMessageId)) return;
      finalizeCommandBlock(state);
      clearStepLive(state);
      const queuedEffort = String(next.modelReasoningEffort ?? "").trim();
      const effort = next.preparedPayload?.model_reasoning_effort
        ?? (queuedEffort || String(state.modelReasoningEffort.value ?? "").trim() || "high");
      const queuedModel = String(next.model ?? "").trim();
      const model = next.preparedPayload?.model ?? (queuedModel || String(state.modelId.value ?? "").trim() || "auto");
      const queuedAgentId = String(next.agentId ?? "").trim();
      const activeAgentId = String(state.activeAgentId.value ?? "").trim();
      const agentId = next.preparedPayload?.agentId ?? (queuedAgentId || activeAgentId);
      const preparedPayload = next.preparedPayload ?? {
        text: promptText, model_reasoning_effort: effort, model, agentId,
        ...(next.images.length > 0 ? { images: next.images.map(image => ({ ...image })) } : {}),
      };
      // Freeze the first wire payload before handing it to WebSocket. A failed
      // send must not re-upload images or pick up changed model controls.
      state.queuedPrompts.value = state.queuedPrompts.value.map(prompt => prompt.clientMessageId === next.clientMessageId
        ? { ...prompt, preparedPayload, agentId, model, modelReasoningEffort: effort }
        : prompt);
      const execution = {
        ...(agentId ? { agentId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { modelReasoningEffort: effort } : {}),
      };
      const alreadyInMessages = state.messages.value.some((m) => m.id === next.clientMessageId);
      if (!runtimeWasBusy && !alreadyInMessages) {
        pushMessageBeforeLive(
          { id: next.clientMessageId, role: "user", kind: "text", content: display, execution, ts: next.createdAt ?? Date.now() },
          state,
        );
      }
      if (!runtimeWasBusy) {
        pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true, ts: Date.now() }, state);
        state.busy.value = true;
        state.turnInFlight = true;
      }
      if (!runtimeWasBusy || next.restoredFromStorage || next.replayIncomplete) {
        state.pendingAckClientMessageId = next.clientMessageId;
      }
      const recovery = next.restoredFromStorage || next.replayIncomplete ? { replay_incomplete: true } : {};
      const payload = { ...preparedPayload, ...recovery, ...(next.retryOriginal ? { retry_original: true } : {}) };
      if (!isCurrentScope()) return;
      sendAccepted = state.ws.sendPrompt(payload, next.clientMessageId) !== false;
      if (!isCurrentScope()) return;
      if (!sendAccepted) {
        throw new Error("WebSocket prompt send was not accepted");
      }
      saveSentPrompt(state, { ...next, text: promptText, agentId, model, modelReasoningEffort: effort });
      if (!options?.preserveErrorStatus || state.laneStatus.value?.kind !== "error") {
        state.laneStatus.value = null;
      }
      if (next.restoredFromStorage) {
        state.inputLocked.value = true;
        state.laneStatus.value = { kind: "progress", message: "请求已重新发送，正在等待后端结果…" };
      } else if (next.replayIncomplete) {
        state.laneStatus.value = { kind: "progress", message: "Retry sent. Waiting for the response…" };
      }
      state.queuedPrompts.value = state.queuedPrompts.value.filter(
        (prompt) => prompt.clientMessageId !== next.clientMessageId,
      );
      queueMicrotask(() => {
        if (isCurrentScope()) void flushQueuedPrompts(state, { preserveErrorStatus: true });
      });
    } catch {
      if (!isCurrentScope()) return;
      dropEmptyAssistantPlaceholder(state);
      state.busy.value = false;
      state.turnInFlight = false;
      state.turnHasPatch = false;
      if (state.pendingAckClientMessageId === next.clientMessageId) {
        state.pendingAckClientMessageId = null;
      }
      if (!sendAccepted) {
        state.connected.value = false;
        if (next.replayIncomplete || (!options?.preserveErrorStatus && !state.laneStatus.value)) {
          state.laneStatus.value = { kind: "error", message: "Failed to send prompt: connection lost or prompt rejected." };
        }
      }
      state.queuedPrompts.value = state.queuedPrompts.value.map((prompt) =>
        prompt.clientMessageId === next.clientMessageId
          ? { ...prompt, deliveryStatus: "offline" }
          : prompt,
      );
    } finally {
      sending.delete(next.clientMessageId);
    }
  };

  const finalizeAssistant = (content: string, rt?: ProjectRuntime, ts?: number): void => {
    const state = runtimeOrActive(rt);
    const text = String(content ?? "").replace(/\r\n/g, "\n");
    const trimmedText = text.trim();
    const existing = state.messages.value.slice();
    let streamIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        streamIndex = i;
        break;
      }
    }
    if (streamIndex >= 0) {
      const current = String(existing[streamIndex]!.content ?? "");
      if (!trimmedText) {
        if (!current.trim()) {
          setMessages([...existing.slice(0, streamIndex), ...existing.slice(streamIndex + 1)], state);
          return;
        }
        existing[streamIndex]!.streaming = false;
        setMessages(existing.slice(), state);
        return;
      }
      existing[streamIndex]!.content = text;
      existing[streamIndex]!.streaming = false;
      if (Number.isFinite(ts) && (ts as number) > 0) {
        existing[streamIndex]!.ts = Math.floor(ts as number);
      }
      setMessages(existing.slice(), state);
      return;
    }

    if (!trimmedText) return;
    const normalizedText = trimmedText;
    const lastNonLive = (() => {
      for (let i = existing.length - 1; i >= 0; i--) {
        const m = existing[i]!;
        if (isLiveMessageId(m.id)) continue;
        return m;
      }
      return null;
    })();
    if (lastNonLive?.role === "assistant" && lastNonLive.kind === "text") {
      const prev = String(lastNonLive.content ?? "").replace(/\r\n/g, "\n").trim();
      if (prev === normalizedText) {
        return;
      }
    }

    pushMessageBeforeLive({ role: "assistant", kind: "text", content: text, ts: (Number.isFinite(ts) && (ts as number) > 0) ? Math.floor(ts as number) : Date.now() }, state);
  };

  return {
    bindPromptOutbox: ensureOutboxBinding,
    isLiveMessageId,
    findFirstLiveIndex,
    findLastLiveIndex,
    savePendingPrompt,
    clearPendingPrompt,
    clearPendingPromptReplayState,
    markPromptConsumed,
    markPromptCancelled,
    markPromptRetired,
    reconcilePromptOutbox,
    applyPromptReconciliation,
    dismissPromptByClientMessageId,
    restorePendingPrompt,
    trimChatItems,
    setMessages,
    pushMessageBeforeLive,
    pushRecentCommand,
    resetConversation,
    threadReset,
    clearConversationForResume,
    applyResumeHistory,
    cancelPendingResume,
    applyStreamingDisconnectCleanup,
    applyMergedHistory,
    dropEmptyAssistantPlaceholder,
    hasEmptyAssistantPlaceholder,
    hasAssistantAfterLastUser,
    ingestCommand,
    ingestCommandActivity,
    ingestExploredActivity,
    commandKeyForWsEvent,
    upsertExecuteBlock,
    finalizeCommandBlock,
    removeQueuedPrompt,
    retryQueuedPrompt,
    enqueuePrompt,
    enqueueMainPrompt,
    retryPrompt,
    flushQueuedPrompts,
    upsertStreamingDelta,
    replaceStreamingText,
    upsertThoughtDelta,
    upsertLiveActivity,
    clearStepLive,
    sealActiveStreamingAssistant,
    finalizeAssistant,
  };
}

export type ChatActions = ReturnType<typeof createChatActions>;
