<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdownToHtml } from "../lib/markdown";

const props = defineProps<{
  content: string;
  tone?: "default" | "inverted";
}>();

let lastCodeCopyButton: HTMLButtonElement | null = null;
let lastCodeCopyTimer: ReturnType<typeof setTimeout> | null = null;

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

function resetCodeCopyToast(): void {
  if (lastCodeCopyTimer) {
    clearTimeout(lastCodeCopyTimer);
    lastCodeCopyTimer = null;
  }
  if (lastCodeCopyButton) {
    lastCodeCopyButton.setAttribute("data-state", "idle");
    lastCodeCopyButton = null;
  }
}

async function onClick(ev: MouseEvent): Promise<void> {
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  const btn = target.closest("button.md-codecopy") as HTMLButtonElement | null;
  if (!btn) return;

  const wrapper = btn.closest(".md-codeblock");
  const codeEl = wrapper?.querySelector("pre code") as HTMLElement | null;
  const codeText = codeEl?.textContent ?? "";
  if (!codeText.trim()) return;

  const ok = await copyToClipboard(codeText);
  if (!ok) return;

  resetCodeCopyToast();
  btn.setAttribute("data-state", "copied");
  lastCodeCopyButton = btn;
  lastCodeCopyTimer = setTimeout(() => {
    resetCodeCopyToast();
  }, 1400);
}

const html = computed(() => renderMarkdownToHtml(props.content));
</script>

<template>
  <div class="md" :class="{ inverted: tone === 'inverted' }" v-html="html" @click="onClick" />
</template>

<style scoped>
.md {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.md.inverted {
  color: rgba(255, 255, 255, 0.95);
}

.md :deep(p) {
  margin: 0;
}

.md :deep(p + p) {
  margin-top: 8px;
}

.md :deep(ul),
.md :deep(ol) {
  margin: 6px 0 6px 18px;
  padding: 0;
}

.md :deep(li) {
  margin: 3px 0;
}

.md :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.md.inverted :deep(a) {
  color: rgba(255, 255, 255, 0.95);
}

.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
}

.md :deep(:not(pre) > code) {
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid rgba(226, 232, 240, 0.9);
}

.md.inverted :deep(:not(pre) > code) {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.22);
}

.md :deep(.md-codeblock) {
  position: relative;
  margin: 8px 0;
}

.md :deep(details.md-codeblock) {
  border: none;
  padding: 0;
}

.md :deep(details.md-codeblock > summary) {
  list-style: none;
  cursor: pointer;
  user-select: none;
  border-radius: 10px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.03);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  color: rgba(15, 23, 42, 0.85);
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.md :deep(details.md-codeblock > summary::-webkit-details-marker) {
  display: none;
}

.md :deep(details.md-codeblock > summary .md-collapsible-title) {
  font-weight: 800;
  color: rgba(15, 23, 42, 0.92);
  flex: 0 0 auto;
}

.md :deep(details.md-codeblock > summary .md-collapsible-files) {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
}

.md :deep(details.md-codeblock > summary .md-collapsible-hint) {
  flex: 0 0 auto;
  opacity: 0.7;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.md :deep(details.md-codeblock[open] > summary) {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.md :deep(.md-codeblock pre) {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.03);
  overflow-x: auto;
  overflow-y: auto;
  max-height: min(40vh, 360px);
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}

.md :deep(details.md-codeblock[open] .md-codeblock-body pre) {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.md.inverted :deep(.md-codeblock pre) {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.12);
}

.md :deep(.md-codecopy) {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(255, 255, 255, 0.9);
  color: #475569;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.65;
  transition: opacity 120ms ease;
  display: grid;
  place-items: center;
}

.md.inverted :deep(.md-codecopy) {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(37, 99, 235, 0.55);
  color: rgba(255, 255, 255, 0.95);
}

.md :deep(.md-codecopy .md-icon.check) {
  display: none;
}

.md :deep(.md-codecopy[data-state="copied"] .md-icon.copy) {
  display: none;
}

.md :deep(.md-codecopy[data-state="copied"] .md-icon.check) {
  display: block;
}

.md :deep(.md-codeblock:hover .md-codecopy) {
  opacity: 1;
}

.md :deep(.hljs) {
  background: transparent;
  color: #0f172a;
}

.md.inverted :deep(.hljs) {
  color: rgba(255, 255, 255, 0.95);
}

.md :deep(.hljs-keyword),
.md :deep(.hljs-selector-tag),
.md :deep(.hljs-literal) {
  color: #7c3aed;
}

.md :deep(.hljs-string),
.md :deep(.hljs-title),
.md :deep(.hljs-section),
.md :deep(.hljs-attr) {
  color: #0f766e;
}

.md :deep(.hljs-comment) {
  color: #94a3b8;
}

.md.inverted :deep(.hljs-comment) {
  color: rgba(226, 232, 240, 0.7);
}

.md :deep(.hljs-number) {
  color: #b45309;
}

.md :deep(img) {
  display: block;
  max-width: 25%;
  height: auto;
  max-height: 20vh;
  object-fit: contain;
}

@media (max-width: 480px) {
  .md :deep(img) {
    max-width: 50%;
  }
}
</style>
