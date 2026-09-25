import { ref, watch } from "vue";

import type { ChatItem, ProjectRuntime } from "./controllerTypes";

export type TranscriptViewport = {
  following: boolean;
  firstLoadedId: string;
  anchorId: string;
  anchorOffset: number;
  scrollTop: number;
  // Optional for backwards compatibility with v1 records written before
  // viewport freshness was tracked.
  tailMessageId?: string;
};

export type TranscriptScope = {
  projectId: string;
  sessionId: string;
  chatSessionId: string;
  workspace: string;
};

export const TRANSCRIPT_CACHE_PREFIX = "ads.transcript.v1.";
export const TRANSCRIPT_OWNER_KEY = "ads.transcript.owner";
const MAX_RECORD_CHARS = 1_000_000;
const FLUSH_DELAY_MS = 250;

type CachedTranscript = {
  version: 1;
  key: string;
  messages: ChatItem[];
  cursor: number;
  generation: number;
  complete: boolean;
  viewport: TranscriptViewport | null;
  savedAt: number;
};

export function transcriptCacheKey(owner: string, scope: TranscriptScope): string {
  return TRANSCRIPT_CACHE_PREFIX + JSON.stringify([
    owner, scope.projectId, scope.sessionId, scope.chatSessionId, scope.workspace,
  ]);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validMessage(value: unknown): value is ChatItem {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.content !== "string") return false;
  if (!["user", "assistant", "system"].includes(String(value.role))) return false;
  if (!["text", "command", "execute", "patch", "error", "divider"].includes(String(value.kind))) return false;
  for (const field of ["fullContent", "command"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  for (const field of ["streaming", "transient"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
  }
  for (const field of ["ts", "hiddenLineCount", "commandsTotal", "commandsShown", "commandsLimit", "retryCount"]) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)) return false;
  }
  if (value.execution !== undefined) {
    if (!record(value.execution)) return false;
    for (const field of ["agentId", "model", "modelReasoningEffort", "effectiveAgentId", "effectiveModel", "effectiveModelReasoningEffort"]) {
      if (value.execution[field] !== undefined && typeof value.execution[field] !== "string") return false;
    }
  }
  if (value.patch !== undefined) {
    const patch = value.patch;
    if (!record(patch) || typeof patch.diff !== "string" || !Array.isArray(patch.files)) return false;
    if (patch.truncated !== undefined && typeof patch.truncated !== "boolean") return false;
    if (!patch.files.every((file) => record(file) && typeof file.path === "string" &&
      [file.added, file.removed].every((count) => count === null || (typeof count === "number" && Number.isFinite(count))))) return false;
  }
  if (value.plan !== undefined) return false;
  return true;
}

function validViewport(value: unknown): value is TranscriptViewport {
  return record(value) && typeof value.following === "boolean" &&
    typeof value.firstLoadedId === "string" && typeof value.anchorId === "string" &&
    typeof value.anchorOffset === "number" && Number.isFinite(value.anchorOffset) &&
    typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0 &&
    (value.tailMessageId === undefined || typeof value.tailMessageId === "string");
}

export function readCachedTranscript(key: string): CachedTranscript | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > MAX_RECORD_CHARS) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 1 || parsed.key !== key ||
      !Number.isSafeInteger(parsed.cursor) || Number(parsed.cursor) < 0 ||
      !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1 ||
      typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt) ||
      typeof parsed.complete !== "boolean" || !Array.isArray(parsed.messages) ||
      !parsed.messages.every(validMessage) ||
      new Set(parsed.messages.map((message) => message.id)).size !== parsed.messages.length ||
      (parsed.viewport !== null && !validViewport(parsed.viewport))) return null;
    return parsed as CachedTranscript;
  } catch {
    return null;
  }
}

function cacheKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith(TRANSCRIPT_CACHE_PREFIX));
}

function saveCachedTranscript(value: CachedTranscript): void {
  try {
    const serialized = JSON.stringify(value);
    // Keep the last complete record rather than saving a tail with a cursor
    // that would falsely claim to cover the omitted history.
    if (serialized.length > MAX_RECORD_CHARS) return;
    try {
      localStorage.setItem(value.key, serialized);
    } catch {
      const candidates = cacheKeys().filter((key) => key !== value.key).sort((left, right) =>
        (readCachedTranscript(left)?.savedAt ?? 0) - (readCachedTranscript(right)?.savedAt ?? 0));
      for (const key of candidates) {
        localStorage.removeItem(key);
        try {
          localStorage.setItem(value.key, serialized);
          break;
        } catch {
          // Evict only this cache's records; never touch outbox or credentials.
        }
      }
    }
  } catch {
    // Storage is an optional optimization, including in private browsing.
  }
}

export function createTranscriptCache() {
  const owner = ref("");
  try { owner.value = localStorage.getItem(TRANSCRIPT_OWNER_KEY) ?? ""; } catch { /* Storage may be disabled. */ }
  const bindings = new Map<ProjectRuntime, { key: string; scope: TranscriptScope; flush: () => void; dispose: () => void }>();

  const attach = (rt: ProjectRuntime, scope: TranscriptScope): void => {
    if (!owner.value) return;
    const key = transcriptCacheKey(owner.value, scope);
    const previous = bindings.get(rt);
    if (previous?.key === key) return;
    previous?.flush();
    previous?.dispose();
    if (previous) {
      // A new worker session retains the old conversation above its divider.
      // The server copies that review-only history into the new lane too.
      const sameProject = previous.scope.projectId === scope.projectId &&
        previous.scope.sessionId === scope.sessionId && previous.scope.workspace === scope.workspace;
      if (!sameProject) {
        rt.messages.value = [];
      }
      // A viewport belongs to one chat session only. Keep the review-only
      // messages above the new divider, but never restore its scroll position
      // into a different session scope.
      rt.transcriptViewport.value = null;
      rt.transcriptReady = false;
      rt.transcriptRestored = false;
      rt.transcriptCursor = 0;
    }
    rt.projectSessionId = scope.sessionId;
    rt.chatSessionId = scope.chatSessionId;
    const cached = readCachedTranscript(key);
    if (cached) {
      rt.messages.value = cached.messages.map((message) => message.streaming ? { ...message, streaming: false } : message);
      rt.transcriptViewport.value = cached.viewport;
      rt.transcriptCursor = cached.complete ? cached.cursor : 0;
      rt.transcriptReady = cached.complete;
      rt.transcriptRestored = true;
      rt.laneGeneration = cached.generation;
      rt.laneGenerationScope = `${scope.sessionId}::${scope.chatSessionId}`;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idle: number | null = null;
    const cancel = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback(idle);
      timer = null;
      idle = null;
    };
    const flush = (): void => {
      cancel();
      if (disposed || !rt.laneGeneration) return;
      saveCachedTranscript({
        version: 1, key,
        messages: rt.messages.value.filter((message) => message.kind !== "thought" && message.kind !== "plan"),
        cursor: rt.transcriptCursor,
        generation: rt.laneGeneration,
        complete: rt.transcriptReady && !rt.busy.value && !rt.turnInFlight && !rt.syncInProgress &&
          !rt.awaitingBootstrapHistory && !rt.messages.value.some((message) => message.streaming),
        viewport: rt.transcriptViewport.value,
        savedAt: Date.now(),
      });
    };
    const schedule = (): void => {
      if (disposed || timer !== null || idle !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (typeof window.requestIdleCallback === "function") {
          idle = window.requestIdleCallback(flush, { timeout: 1000 });
        } else {
          flush();
        }
      }, FLUSH_DELAY_MS);
    };
    const invalidate = (): void => {
      cancel();
      rt.transcriptCursor = 0;
      rt.transcriptReady = false;
      rt.transcriptRestored = false;
      rt.transcriptViewport.value = null;
      try { localStorage.removeItem(key); } catch { /* Best effort. */ }
    };
    // Array commits are already batched by the streaming reducer. A deep
    // watcher would walk the entire transcript for every incoming token.
    const stop = watch([rt.messages, rt.busy, rt.transcriptViewport], schedule, { flush: "post" });
    rt.transcriptCache = { schedule, invalidate };
    bindings.set(rt, { key, scope, flush, dispose: () => { disposed = true; cancel(); stop(); } });
  };

  const flush = (): void => { for (const binding of bindings.values()) binding.flush(); };
  const detach = (rt: ProjectRuntime): void => {
    const binding = bindings.get(rt);
    binding?.dispose();
    bindings.delete(rt);
    rt.transcriptCache = undefined;
    if (binding) {
      try { localStorage.removeItem(binding.key); } catch { /* Best effort. */ }
    }
  };
  const dispose = (): void => {
    for (const binding of bindings.values()) binding.dispose();
    bindings.clear();
  };
  const clear = (): void => {
    dispose();
    owner.value = "";
    try {
      for (const key of cacheKeys()) localStorage.removeItem(key);
      localStorage.removeItem(TRANSCRIPT_OWNER_KEY);
    } catch { /* Best effort. */ }
  };
  const setOwner = (id: string): void => {
    if (owner.value && owner.value !== id) clear();
    owner.value = id;
    try { localStorage.setItem(TRANSCRIPT_OWNER_KEY, id); } catch { /* Best effort. */ }
  };
  return { owner, attach, flush, detach, dispose, clear, setOwner };
}
