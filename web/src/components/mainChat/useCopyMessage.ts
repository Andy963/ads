import { onBeforeUnmount, ref } from "vue";

import type { ChatMessage } from "./types";

async function copyToClipboard(text: string): Promise<boolean> {
  const normalized = String(text ?? "");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalized);
      return true;
    } catch {
      // fallback below
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = normalized;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

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
    const ok = await copyToClipboard(message.content);
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

