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

type HeightCheck = { heights: number[]; ok: boolean };
const heightCheck = ref<HeightCheck | null>(null);

type OffsetCheck = { deltas: number[]; ok: boolean };
const offsetCheck = ref<OffsetCheck | null>(null);

type UnderlayPeekCheck = { peeks: number[]; ok: boolean };
const underlayPeekCheck = ref<UnderlayPeekCheck | null>(null);

type LayoutMetric = {
  kind: "execute-block" | "execute-underlay";
  layer?: string;
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
  return [
    { id: "u-1", role: "user", kind: "text", content: "Execute block fixture: stacked then single." },
    { id: "e-1", role: "system", kind: "execute", content: "short output", command: "echo short" },
    { id: "e-2", role: "system", kind: "execute", content: "", command: "echo no output" },
    { id: "e-3", role: "system", kind: "execute", content: longOutput, command: longCommand },
    { id: "a-1", role: "assistant", kind: "text", content: "done" },
    { id: "e-4", role: "system", kind: "execute", content: "", command: "echo single" },
  ];
});

onMounted(() => {
  void (async () => {
    await nextTick();
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".execute-block, .execute-underlay"));
    const metrics = blocks.map((el) => {
      const rect = el.getBoundingClientRect();
      const kind = el.classList.contains("execute-underlay") ? "execute-underlay" : "execute-block";
      const layer = el.getAttribute("data-layer") || undefined;
      return {
        kind,
        layer,
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
      } satisfies LayoutMetric;
    });
    layoutMetrics.value = metrics;

    const heights = metrics.map((m) => m.height);
    const min = heights.length ? Math.min(...heights) : 0;
    const max = heights.length ? Math.max(...heights) : 0;
    heightCheck.value = { heights, ok: heights.length > 0 && max - min <= 1 };

    const stack = document.querySelector<HTMLElement>(".execute-stack[data-stack]");
    const stackBlock = stack?.querySelector<HTMLElement>(".execute-block") || null;
    const underlays = Array.from(stack?.querySelectorAll<HTMLElement>(".execute-underlay") || []);
    if (stackBlock && underlays.length > 0) {
      const blockTop = stackBlock.getBoundingClientRect().top;
      const deltas = underlays
        .map((el) => {
          const top = el.getBoundingClientRect().top;
          return Math.round(top - blockTop);
        })
        // Expect the closest underlay to be around -6px, then -12px, etc.
        .sort((a, b) => b - a);
      const ok = deltas.every((d, idx) => Math.abs(d + (idx + 1) * 6) <= 1);
      offsetCheck.value = { deltas, ok };

      // Underlays should not visibly extend beyond the main block.
      const stackRect = stack.getBoundingClientRect();
      const peeks = underlays
        .map((el) => {
          const r = el.getBoundingClientRect();
          const peekBottom = Math.max(0, Math.round(r.bottom - stackRect.bottom));
          return peekBottom;
        })
        .sort((a, b) => a - b);
      underlayPeekCheck.value = { peeks, ok: peeks.every((n) => n === 0) };
    } else {
      offsetCheck.value = { deltas: [], ok: false };
      underlayPeekCheck.value = { peeks: [], ok: false };
    }
  })();
});
</script>

<template>
  <div class="fixture">
    <div class="fixtureHeader">
      <div class="fixtureTitle">Execute Block Fixture</div>
      <div class="fixtureHint">Use this page to visually confirm all execute blocks have the same outer size.</div>
      <div class="fixtureHint">Stacked blocks should keep the main card height stable; underlays should only peek above the top edge.</div>
      <div v-if="heightCheck" class="fixtureCheck" :data-ok="heightCheck.ok ? 'true' : 'false'">
        <span class="fixtureCheckLabel">Height check:</span>
        <span class="fixtureCheckValue">{{ heightCheck.ok ? "OK" : "MISMATCH" }}</span>
        <span class="fixtureCheckValue">({{ heightCheck.heights.join(", ") }}px)</span>
      </div>
      <div v-if="offsetCheck" class="fixtureCheck" :data-ok="offsetCheck.ok ? 'true' : 'false'">
        <span class="fixtureCheckLabel">Offset check:</span>
        <span class="fixtureCheckValue">{{ offsetCheck.ok ? "OK" : "MISMATCH" }}</span>
        <span class="fixtureCheckValue">({{ offsetCheck.deltas.join(", ") }}px)</span>
      </div>
      <div v-if="underlayPeekCheck" class="fixtureCheck" :data-ok="underlayPeekCheck.ok ? 'true' : 'false'">
        <span class="fixtureCheckLabel">Underlay peek:</span>
        <span class="fixtureCheckValue">{{ underlayPeekCheck.ok ? "OK" : "PEEK" }}</span>
        <span class="fixtureCheckValue">({{ underlayPeekCheck.peeks.join(", ") }}px)</span>
      </div>
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
