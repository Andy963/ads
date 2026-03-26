<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { renderMarkdownToHtml, type MarkdownFilePreviewLink } from "../lib/markdown";
import { copyTextToClipboard } from "../lib/clipboard";

const props = defineProps<{
  content: string;
  tone?: "default" | "inverted";
  enableFilePreview?: boolean;
}>();

const emit = defineEmits<{
  (e: "openFilePreview", payload: MarkdownFilePreviewLink): void;
}>();

let lastCodeCopyButton: HTMLButtonElement | null = null;
let lastCodeCopyTimer: ReturnType<typeof setTimeout> | null = null;

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

onBeforeUnmount(() => {
  resetCodeCopyToast();
});

async function onClick(ev: MouseEvent): Promise<void> {
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  const btn = target.closest("button.md-codecopy") as HTMLButtonElement | null;
  if (btn) {
    const wrapper = btn.closest(".md-codeblock");
    const codeEl = wrapper?.querySelector("pre code") as HTMLElement | null;
    const codeText = codeEl?.textContent ?? "";
    if (!codeText.trim()) return;

    const ok = await copyTextToClipboard(codeText);
    if (!ok) return;

    resetCodeCopyToast();
    btn.setAttribute("data-state", "copied");
    lastCodeCopyButton = btn;
    lastCodeCopyTimer = setTimeout(() => {
      resetCodeCopyToast();
    }, 1400);
    return;
  }

  if (!props.enableFilePreview) return;
  const anchor = target.closest("a[data-md-link-kind='file-preview']") as HTMLAnchorElement | null;
  if (!anchor) return;

  const rawPath = String(anchor.getAttribute("data-md-file-path") ?? "").trim();
  if (!rawPath) return;
  const rawLine = String(anchor.getAttribute("data-md-file-line") ?? "").trim();
  const line = /^\d+$/.test(rawLine) ? Number.parseInt(rawLine, 10) : null;
  ev.preventDefault();
  emit("openFilePreview", { path: rawPath, line: Number.isFinite(line ?? NaN) ? line : null });
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
  color: var(--github-text);
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

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 10px 0 6px 0;
  font-weight: 800;
  line-height: 1.35;
  color: inherit;
}

/*
  Markdown headings default to very large browser styles (e.g. h1 ~2em).
  Clamp them to chat-friendly typography so pasted prompts don't blow up the layout.
*/
.md :deep(h1) {
  font-size: 15px;
}

.md :deep(h2) {
  font-size: 14px;
}

.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  font-size: 13px;
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
  color: var(--github-accent);
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
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(175, 184, 193, 0.2);
  border: 1px solid rgba(208, 215, 222, 0.8);
  color: #cf222e;
}

.md :deep(.md-diffstat) {
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
}

.md :deep(.md-diffstat-add) {
  color: #16a34a;
  font-weight: 700;
}

.md :deep(.md-diffstat-del) {
  color: var(--danger);
  font-weight: 700;
}

.md.inverted :deep(.md-diffstat-add) {
  color: #4ade80;
}

.md.inverted :deep(.md-diffstat-del) {
  color: #f87171;
}

.md.inverted :deep(:not(pre) > code) {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.22);
}

.md :deep(.md-codeblock) {
  position: relative;
  margin: 8px 0;
  border: 1px solid var(--github-border);
  border-radius: 12px;
  background: var(--github-code-bg);
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
}

.md :deep(details.md-codeblock) {
  padding: 0;
}

.md :deep(details.md-codeblock > summary) {
  list-style: none;
  cursor: pointer;
  user-select: none;
  border-radius: 0;
  border: none;
  border-bottom: 1px solid var(--github-border);
  background: var(--github-code-header);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  color: var(--github-muted);
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.md :deep(details.md-codeblock[data-kind="patch"]) {
  margin: 6px 0;
}

.md :deep(details.md-codeblock[data-kind="patch"] > summary) {
  padding: 6px 10px;
  line-height: 1.35;
  align-items: center;
  gap: 8px;
}

.md :deep(details.md-codeblock > summary::-webkit-details-marker) {
  display: none;
}

.md :deep(details.md-codeblock > summary .md-collapsible-title) {
  font-weight: 800;
  color: var(--github-text);
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

.md :deep(details.md-codeblock > summary .md-collapsible-hint::before) {
  content: attr(data-closed);
}

.md :deep(details.md-codeblock[open] > summary .md-collapsible-hint::before) {
  content: attr(data-open);
}

.md :deep(details.md-codeblock[open] > summary) {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.md :deep(.md-codeblock pre) {
  margin: 0;
  padding: 14px 16px;
  border-radius: 0;
  border: none;
  background: transparent;
  overflow-x: auto;
  overflow-y: auto;
  max-height: min(40vh, 360px);
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.45) transparent;
}

.md :deep(.md-codeblock pre)::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.md :deep(.md-codeblock pre)::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.45);
  border-radius: 999px;
}

.md :deep(.md-codeblock pre)::-webkit-scrollbar-track {
  background: transparent;
}

.md :deep(details.md-codeblock[data-kind="patch"] .md-codeblock-body pre) {
  padding: 8px 10px;
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
  top: 10px;
  right: 10px;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--github-border);
  background: rgba(255, 255, 255, 0.92);
  color: var(--github-muted);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.75;
  transition:
    opacity 120ms ease,
    background 120ms ease,
    color 120ms ease,
    border-color 120ms ease,
    outline-color 120ms ease;
  display: grid;
  place-items: center;
}

.md :deep(.md-codecopy:hover) {
  opacity: 1;
  background: #ffffff;
  border-color: var(--github-border);
  color: var(--github-text);
}

.md :deep(.md-codecopy:active),
.md :deep(.md-codecopy:focus),
.md :deep(.md-codecopy:focus-visible) {
  background: #ffffff;
  border-color: rgba(9, 105, 218, 0.35);
  color: var(--github-text);
}

.md :deep(.md-codecopy:focus-visible) {
  outline: 2px solid rgba(9, 105, 218, 0.28);
  outline-offset: 2px;
}

.md.inverted :deep(.md-codecopy) {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.26);
  color: rgba(255, 255, 255, 0.82);
}

.md.inverted :deep(.md-codecopy:hover) {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.38);
  color: rgba(255, 255, 255, 0.95);
}

.md.inverted :deep(.md-codecopy:active),
.md.inverted :deep(.md-codecopy:focus),
.md.inverted :deep(.md-codecopy:focus-visible) {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.46);
  color: rgba(255, 255, 255, 0.98);
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
  color: var(--github-text);
}

.md.inverted :deep(.hljs) {
  color: rgba(255, 255, 255, 0.95);
}

.md :deep(.hljs-keyword),
.md :deep(.hljs-selector-tag),
.md :deep(.hljs-literal),
.md :deep(.hljs-subst) {
  color: #cf222e;
}

.md :deep(.hljs-string),
.md :deep(.hljs-title),
.md :deep(.hljs-section),
.md :deep(.hljs-doctag),
.md :deep(.hljs-regexp) {
  color: #0a3069;
}

.md :deep(.hljs-comment),
.md :deep(.hljs-quote) {
  color: #6e7781;
  font-style: italic;
}

.md.inverted :deep(.hljs-comment) {
  color: rgba(226, 232, 240, 0.7);
}

.md :deep(.hljs-number) {
  color: #0550ae;
}

.md :deep(.hljs-attr),
.md :deep(.hljs-attribute),
.md :deep(.hljs-property),
.md :deep(.hljs-variable),
.md :deep(.hljs-template-variable),
.md :deep(.hljs-link),
.md :deep(.hljs-symbol) {
  color: #0550ae;
}

.md :deep(.hljs-built_in),
.md :deep(.hljs-type),
.md :deep(.hljs-class .hljs-title),
.md :deep(.hljs-function .hljs-title),
.md :deep(.hljs-selector-id),
.md :deep(.hljs-selector-class) {
  color: #8250df;
}

.md :deep(.hljs-addition) {
  color: #116329;
  background: rgba(46, 160, 67, 0.14);
}

.md :deep(.hljs-deletion) {
  color: #cf222e;
  background: rgba(248, 81, 73, 0.14);
}

.md :deep(.hljs-meta) {
  color: #953800;
}

.md.inverted :deep(.hljs-addition) {
  color: rgba(134, 239, 172, 0.95);
}

.md.inverted :deep(.hljs-deletion) {
  color: rgba(252, 165, 165, 0.95);
}

.md.inverted :deep(.hljs-meta) {
  color: rgba(226, 232, 240, 0.9);
}

.md :deep(img) {
  display: block;
  max-width: 25%;
  height: auto;
  max-height: 20vh;
  object-fit: contain;
}

.md :deep(blockquote) {
  margin: 10px 0;
  padding: 0 0 0 12px;
  border-left: 4px solid var(--github-border-muted);
  color: var(--github-muted);
}

.md :deep(hr) {
  margin: 14px 0;
  border: 0;
  border-top: 1px solid var(--github-border-muted);
}

.md :deep(table) {
  width: 100%;
  margin: 10px 0;
  border-collapse: collapse;
  border-spacing: 0;
  display: block;
  overflow-x: auto;
}

.md :deep(th),
.md :deep(td) {
  padding: 6px 12px;
  border: 1px solid var(--github-border-muted);
  text-align: left;
}

.md :deep(th) {
  background: var(--github-code-header);
  font-weight: 700;
}

.md :deep(tr:nth-child(2n) td) {
  background: rgba(246, 248, 250, 0.72);
}

.md :deep(strong) {
  color: var(--github-text);
}

@media (max-width: 480px) {
  .md :deep(img) {
    max-width: 50%;
  }
}
</style>
