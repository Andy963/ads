import { onBeforeUnmount, ref } from "vue";

import { copyTextToClipboard } from "../../lib/clipboard";
import type { ChatMessage } from "./types";

export function useCopyMessage() {
  const copiedMessageId = ref<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCopiedToast = () => {
    if (copiedTimer) {
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }
    copiedMessageId.value = null;
  };

  const onCopyMessage = async (message: ChatMessage): Promise<void> => {
    const ok = await copyTextToClipboard(message.content);
    if (!ok) return;
    clearCopiedToast();
    copiedMessageId.value = message.id;
    copiedTimer = setTimeout(() => {
      copiedMessageId.value = null;
      copiedTimer = null;
    }, 1400);
  };

  const formatMessageTs = (ts?: number): string => {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
    const date = new Date(ts);
    if (!Number.isFinite(date.getTime())) return "";

    const pad2 = (num: number) => String(num).padStart(2, "0");
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
  };

  onBeforeUnmount(() => {
    clearCopiedToast();
  });

  return {
    copiedMessageId,
    onCopyMessage,
    formatMessageTs,
  };
}
