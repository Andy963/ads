<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

// Keep phase updates local so animating a placeholder never re-renders its transcript.
const phase = ref(0);
let phaseTimer: ReturnType<typeof setInterval> | null = null;

function stopPhase(): void {
  if (phaseTimer === null) return;
  clearInterval(phaseTimer);
  phaseTimer = null;
}

function updateForegroundPhase(): void {
  if (document.visibilityState === "hidden") {
    stopPhase();
  } else if (phaseTimer === null) {
    phaseTimer = setInterval(() => {
      phase.value = (phase.value + 1) % 3;
    }, 180);
  }
}

onMounted(() => {
  updateForegroundPhase();
  document.addEventListener("visibilitychange", updateForegroundPhase);
});

onBeforeUnmount(() => {
  stopPhase();
  document.removeEventListener("visibilitychange", updateForegroundPhase);
});
</script>

<template>
  <span class="thinkingDots" aria-hidden="true">
    <span
      v-for="dotIndex in 3"
      :key="dotIndex"
      class="thinkingDot"
      :class="{ 'thinkingDot--active': phase === dotIndex - 1 }"
    ></span>
  </span>
</template>

<style scoped>
.thinkingDots {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  margin-left: 5px;
}

.thinkingDot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.3;
  transform: translate3d(0, 0, 0) scale(0.85);
  transition: opacity 120ms linear, transform 120ms ease-out;
  will-change: opacity, transform;
}

.thinkingDot--active {
  opacity: 1;
  transform: translate3d(0, -2px, 0) scale(1.15);
}
</style>
