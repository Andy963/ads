import type { AppContext, ProjectRuntime } from "../controller";
import type { ChatActions } from "../chat";
import { createOutboxStore, legacyPendingPromptStorageKey, outboxStorageKey } from "../outbox";

type SessionSwitchIntent = { chatSessionId: string; sentOn?: ProjectRuntime["ws"] };

// Runtime ownership also fences these intents at the account boundary. A cached
// project selection alone is not a request to override the server on reconnect.
const switchIntents = new WeakMap<ProjectRuntime, SessionSwitchIntent>();

export function requestChatSessionSwitch(rt: ProjectRuntime, chatSessionId: string): SessionSwitchIntent {
  const intent = { chatSessionId };
  switchIntents.set(rt, intent);
  rt.syncInProgress = true;
  return intent;
}

export function pendingChatSessionSwitch(rt: ProjectRuntime): SessionSwitchIntent | undefined {
  return switchIntents.get(rt);
}

export function confirmChatSessionSwitch(rt: ProjectRuntime): void {
  switchIntents.delete(rt);
}

export function persistChatSessionSelection(
  projects: AppContext["projects"],
  projectId: string,
  chatSessionId: string,
  persistProjects: () => void,
): void {
  if (!projects.value.some((project) => project.id === projectId && project.chatSessionId !== chatSessionId)) return;
  projects.value = projects.value.map((project) => project.id === projectId
    ? { ...project, chatSessionId, updatedAt: Date.now() }
    : project);
  persistProjects();
}

export function clearPreviousSessionInputs(ctx: ChatActions, rt: ProjectRuntime): void {
  rt.promptReconciliationPending = true;
  ctx.restorePendingPrompt(rt, true);
  const store = createOutboxStore();
  const snapshot = store.read(outboxStorageKey(rt.projectSessionId, rt.chatSessionId));
  const obsoleteIds = new Set([
    rt.pendingAckClientMessageId,
    ...rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId),
    snapshot.pending?.clientMessageId,
    ...snapshot.sent.map((prompt) => prompt.clientMessageId),
    ...snapshot.queued.map((prompt) => prompt.clientMessageId),
    ...(rt.promptReconciliationIds ?? []),
    ...(snapshot.cancelIntents ?? []),
  ].filter((id): id is string => Boolean(id)));
  // Keep retirement tombstones so an already queued cross-tab outbox broadcast
  // cannot resurrect the discarded inputs after this runtime changes identity.
  for (const id of obsoleteIds) ctx.markPromptRetired(rt, id);
  // Clear while the runtime still names the OLD session: queue watchers and
  // clearPendingPrompt persist synchronously using that identity.
  rt.queuedPrompts.value = [];
  rt.pendingAckClientMessageId = null;
  ctx.clearPendingPrompt(rt);
  rt.promptReconciliationPending = false;
  rt.promptReconciliationIds = undefined;
  rt.pendingImages.value = [];
  ctx.cancelPendingResume(rt);
  rt.transcriptCache?.invalidate();
  rt.transcriptCursor = 0;
  rt.transcriptReady = false;
  rt.transcriptRestored = false;
  rt.transcriptViewport.value = null;
  try {
    sessionStorage.removeItem(legacyPendingPromptStorageKey(rt.projectSessionId, rt.chatSessionId));
    sessionStorage.removeItem(`ads.syncCursor.${rt.projectSessionId}.${rt.chatSessionId}`);
  } catch {
    // Storage is optional in private browsing.
  }
}
