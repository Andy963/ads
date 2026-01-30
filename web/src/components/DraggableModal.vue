<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

type CardVariant = "default" | "wide" | "large";

const props = withDefaults(
  defineProps<{
    cardVariant?: CardVariant;
    handleSelector?: string;
  }>(),
  {
    cardVariant: "default",
    handleSelector: "[data-drag-handle]",
  },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const cardEl = ref<HTMLElement | null>(null);
const offsetX = ref(0);
const offsetY = ref(0);
const dragging = ref(false);

let startClientX = 0;
let startClientY = 0;
let startOffsetX = 0;
let startOffsetY = 0;
let activePointerId: number | null = null;
let minOffsetX = -Infinity;
let maxOffsetX = Infinity;
let minOffsetY = -Infinity;
let maxOffsetY = Infinity;

const MIN_VISIBLE_X_PX = 48;
const MIN_VISIBLE_TOP_PX = 64;
const MIN_VISIBLE_BOTTOM_PX = 48;

const cardStyle = computed(() => {
  return {
    left: "50%",
    top: "50%",
    transform: `translate(-50%, -50%) translate3d(${offsetX.value}px, ${offsetY.value}px, 0)`,
  } as const;
});

function isDraggableStart(ev: PointerEvent): boolean {
  if (ev.button !== 0) return false;
  const target = ev.target as Element | null;
  if (!target) return false;
  return Boolean(target.closest(props.handleSelector));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function updateBounds(): void {
  const card = cardEl.value;
  if (!card) {
    minOffsetX = -Infinity;
    maxOffsetX = Infinity;
    minOffsetY = -Infinity;
    maxOffsetY = Infinity;
    return;
  }

  const rect = card.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const baseLeft = (vw - w) / 2;
  const baseTop = (vh - h) / 2;

  // Clamp translation so the card cannot be dragged fully off-screen.
  minOffsetX = MIN_VISIBLE_X_PX - w - baseLeft;
  maxOffsetX = vw - MIN_VISIBLE_X_PX - baseLeft;
  minOffsetY = MIN_VISIBLE_TOP_PX - h - baseTop;
  maxOffsetY = vh - MIN_VISIBLE_BOTTOM_PX - baseTop;

  offsetX.value = clamp(offsetX.value, minOffsetX, maxOffsetX);
  offsetY.value = clamp(offsetY.value, minOffsetY, maxOffsetY);
}

function onPointerDown(ev: PointerEvent): void {
  if (!isDraggableStart(ev)) return;
  const root = ev.currentTarget as HTMLElement | null;
  if (!root?.setPointerCapture) return;

  updateBounds();

  dragging.value = true;
  activePointerId = ev.pointerId;
  startClientX = ev.clientX;
  startClientY = ev.clientY;
  startOffsetX = offsetX.value;
  startOffsetY = offsetY.value;

  root.setPointerCapture(ev.pointerId);
  ev.preventDefault();
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value) return;
  if (activePointerId !== ev.pointerId) return;
  const nextX = startOffsetX + (ev.clientX - startClientX);
  const nextY = startOffsetY + (ev.clientY - startClientY);
  offsetX.value = clamp(nextX, minOffsetX, maxOffsetX);
  offsetY.value = clamp(nextY, minOffsetY, maxOffsetY);
  ev.preventDefault();
}

function stopDragging(ev: PointerEvent): void {
  if (!dragging.value) return;
  if (activePointerId !== ev.pointerId) return;

  const root = ev.currentTarget as HTMLElement | null;
  try {
    root?.releasePointerCapture?.(ev.pointerId);
  } catch {
    // ignore
  }
  dragging.value = false;
  activePointerId = null;
}

function onWindowResize(): void {
  updateBounds();
}

onMounted(() => {
  updateBounds();
  window.addEventListener("resize", onWindowResize, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
});
</script>

<template>
  <div
    class="draggableOverlay"
    :class="{ isDragging: dragging }"
    role="dialog"
    aria-modal="true"
    @click.self="emit('close')"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="stopDragging"
    @pointercancel="stopDragging"
  >
    <div ref="cardEl" class="draggableCard" :class="{ wide: cardVariant === 'wide', large: cardVariant === 'large' }" :style="cardStyle">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.draggableOverlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(10px);
  z-index: 9999;
}

.draggableOverlay.isDragging {
  user-select: none;
}

.draggableCard {
  position: fixed;
  width: min(520px, 100%);
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.22);
  padding: 18px 18px 16px 18px;
  will-change: transform;
}

.draggableCard.wide {
  width: min(900px, 100%);
  max-height: 88vh;
  overflow: hidden;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  display: flex;
  flex-direction: column;
}

.draggableCard.large {
  width: min(900px, 100%);
  max-height: 88vh;
  overflow: hidden;
  border-radius: 20px;
  padding: 0;
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
}

:deep([data-drag-handle]) {
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.isDragging :deep([data-drag-handle]) {
  cursor: grabbing;
}
</style>
