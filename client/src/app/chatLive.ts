import type { ChatItem } from "./controller";

export const LIVE_STEP_ID = "live-step";
export const LIVE_ACTIVITY_ID = "live-activity";
export const LIVE_MESSAGE_IDS = [LIVE_STEP_ID, LIVE_ACTIVITY_ID] as const;

export function isLiveMessageId(id: string): boolean {
  return (LIVE_MESSAGE_IDS as readonly string[]).includes(id);
}

export function findFirstLiveIndex(items: ChatItem[]): number {
  let idx = -1;
  for (const liveId of LIVE_MESSAGE_IDS) {
    const at = items.findIndex((m) => m.id === liveId);
    if (at < 0) continue;
    idx = idx < 0 ? at : Math.min(idx, at);
  }
  return idx;
}

export function findLastLiveIndex(items: ChatItem[]): number {
  let idx = -1;
  for (const liveId of LIVE_MESSAGE_IDS) {
    const at = items.findIndex((m) => m.id === liveId);
    if (at < 0) continue;
    idx = Math.max(idx, at);
  }
  return idx;
}

