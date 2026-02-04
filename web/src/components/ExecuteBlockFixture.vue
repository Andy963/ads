<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";

import MainChat from "./MainChat.vue";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute";
  content: string;
  command?: string;
  hiddenLineCount?: number;
  ts?: number;
  streaming?: boolean;
};

type LayoutMetric = {
  kind: "execute-block";
  height: number;
  width: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
};
const layoutMetrics = ref<LayoutMetric[] | null>(null);

const showDebug = ref(false);

const messages = computed<ChatMessage[]>(() => {
  const longOutput = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}: lorem ipsum`).join("\n");
  const longCommand = "cat /var/log/example.log | tail -n 200 | sed -n '1,120p'";
  const patchDiff = [
    "diff --git a/web/src/lib/markdown.ts b/web/src/lib/markdown.ts",
    "index 1111111..2222222 100644",
    "--- a/web/src/lib/markdown.ts",
    "+++ b/web/src/lib/markdown.ts",
    "@@ -1,3 +1,4 @@",
    " import MarkdownIt from \"markdown-it\";",
    "+import hljs from \"highlight.js/lib/core\";",
    " import bash from \"highlight.js/lib/languages/bash\";",
    " import diff from \"highlight.js/lib/languages/diff\";",
  ].join("\n");

  return [
    { id: "u-1", role: "user", kind: "text", content: "Execute block fixture: only the newest execute message is rendered." },
    { id: "e-1", role: "system", kind: "execute", content: "short output", command: "echo short" },
    { id: "e-2", role: "system", kind: "execute", content: "", command: "echo no output" },
    { id: "e-3", role: "system", kind: "execute", content: longOutput, command: longCommand },
    { id: "e-4", role: "system", kind: "execute", content: patchDiff, command: "git diff -- web/src/lib/markdown.ts" },
    { id: "a-1", role: "assistant", kind: "text", content: "done" },
  ];
});

onMounted(() => {
  void (async () => {
    await nextTick();
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".execute-block"));
    const metrics = blocks.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        kind: "execute-block",
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
      } satisfies LayoutMetric;
    });
    layoutMetrics.value = metrics;
  })();
});
</script>

<template>
  <div class="fixture">
    <div class="fixtureHeader">
      <div class="fixtureTitle">Execute Block Fixture</div>
      <div class="fixtureHint">Use this page to visually confirm only the newest execute preview is shown.</div>
      <div class="fixtureHint">Execute output is clamped to at most 3 lines; short output should not reserve extra height.</div>
      <label class="fixtureDebugToggle">
        <input v-model="showDebug" type="checkbox" />
        <span>Show layout metrics</span>
      </label>
      <pre v-if="showDebug && layoutMetrics" class="fixtureDebug">{{ JSON.stringify(layoutMetrics, null, 2) }}</pre>
    </div>
    <MainChat :messages="messages" :queued-prompts="[]" :pending-images="[]" :connected="true" :busy="false" />
  </div>
</template>

<style scoped>
.fixture {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.fixtureHeader {
  padding: 12px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.35);
  background: white;
}

.fixtureTitle {
  font-size: 14px;
  font-weight: 800;
  color: #0f172a;
}

.fixtureHint {
  margin-top: 4px;
  font-size: 12px;
  color: #64748b;
}

.fixtureCheck {
  margin-top: 8px;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(15, 23, 42, 0.03);
  font-size: 12px;
  color: #0f172a;
}

.fixtureCheck[data-ok="false"] {
  border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.08);
  color: #b91c1c;
}

.fixtureCheckLabel {
  font-weight: 700;
}

.fixtureCheckValue {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.fixtureDebugToggle {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #0f172a;
}

.fixtureDebugToggle input {
  width: 14px;
  height: 14px;
}

.fixtureDebug {
  margin-top: 8px;
  max-height: 220px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(15, 23, 42, 0.03);
  font-size: 11px;
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
