<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

type CardVariant = "default" | "wide" | "large";

const props = withDefaults(
  defineProps<{
    cardVariant?: CardVariant;
    handleSelector?: string;
    resizable?: boolean;
  }>(),
  {
    cardVariant: "default",
    handleSelector: "[data-drag-handle]",
    resizable: false,
  },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const cardEl = ref<HTMLElement | null>(null);
const offsetX = ref(0);
const offsetY = ref(0);
const dragging = ref(false);
const resizing = ref(false);
const resizeW = ref(0);
const resizeH = ref(0);

let startClientX = 0;
let startClientY = 0;
let startOffsetX = 0;
let startOffsetY = 0;
let activePointerId: number | null = null;
let resizePointerId: number | null = null;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;

const MIN_RESIZE_W = 360;
const MIN_RESIZE_H = 240;
let minOffsetX = -Infinity;
let maxOffsetX = Infinity;
let minOffsetY = -Infinity;
let maxOffsetY = Infinity;
let draggedThisGesture = false;
let suppressOverlayClick = false;
let allowOverlayCloseForGesture = false;

const MIN_VISIBLE_X_PX = 48;
const MIN_VISIBLE_TOP_PX = 64;
const MIN_VISIBLE_BOTTOM_PX = 48;
const CLICK_SUPPRESS_PX = 4;
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[contenteditable='true']",
].join(", ");

const cardStyle = computed(() => {
  const base: Record<string, string> = {
    left: "50%",
    top: "50%",
    transform: `translate(-50%, -50%) translate3d(${offsetX.value}px, ${offsetY.value}px, 0)`,
  };
  if (props.resizable && resizeW.value > 0) {
    base.width = `${resizeW.value}px`;
  }
  if (props.resizable && resizeH.value > 0) {
    base.height = `${resizeH.value}px`;
    base.maxHeight = `${resizeH.value}px`;
  }
  return base;
});

function isDraggableStart(ev: PointerEvent): boolean {
  if (ev.button !== 0) return false;
  const target = ev.target as Element | null;
  if (!target) return false;
  if (target.closest(INTERACTIVE_SELECTOR)) return false;
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
  allowOverlayCloseForGesture = ev.target === ev.currentTarget;
  if (!isDraggableStart(ev)) return;
  const root = ev.currentTarget as HTMLElement | null;
  if (!root?.setPointerCapture) return;

  updateBounds();

  dragging.value = true;
  draggedThisGesture = false;
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
  if (!draggedThisGesture) {
    const dx = Math.abs(ev.clientX - startClientX);
    const dy = Math.abs(ev.clientY - startClientY);
    if (dx + dy >= CLICK_SUPPRESS_PX) {
      draggedThisGesture = true;
    }
  }
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
  if (draggedThisGesture) {
    suppressOverlayClick = true;
    setTimeout(() => {
      suppressOverlayClick = false;
    }, 0);
  }
}

function onResizePointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 || !props.resizable) return;
  const card = cardEl.value;
  if (!card) return;

  ev.preventDefault();
  ev.stopPropagation();
  resizing.value = true;
  resizePointerId = ev.pointerId;
  resizeStartX = ev.clientX;
  resizeStartY = ev.clientY;
  const rect = card.getBoundingClientRect();
  resizeStartW = rect.width;
  resizeStartH = rect.height;
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
}

function onResizePointerMove(ev: PointerEvent): void {
  if (!resizing.value || resizePointerId !== ev.pointerId) return;
  ev.preventDefault();
  const dx = ev.clientX - resizeStartX;
  const dy = ev.clientY - resizeStartY;
  resizeW.value = Math.max(MIN_RESIZE_W, resizeStartW + dx);
  resizeH.value = Math.max(MIN_RESIZE_H, resizeStartH + dy);
}

function onResizePointerUp(ev: PointerEvent): void {
  if (!resizing.value || resizePointerId !== ev.pointerId) return;
  try {
    (ev.currentTarget as HTMLElement)?.releasePointerCapture?.(ev.pointerId);
  } catch { /* ignore */ }
  resizing.value = false;
  resizePointerId = null;
}

function onWindowResize(): void {
  updateBounds();
}

function onWindowKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    emit("close");
  }
}

function onOverlayClick(): void {
  if (suppressOverlayClick || !allowOverlayCloseForGesture) {
    return;
  }
  emit("close");
}

onMounted(() => {
  updateBounds();
  window.addEventListener("resize", onWindowResize, { passive: true });
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("keydown", onWindowKeydown);
});
</script>

<template>
  <div
    class="draggableOverlay"
    :class="{ isDragging: dragging, isResizing: resizing }"
    role="dialog"
    aria-modal="true"
    @click.self="onOverlayClick"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="stopDragging"
    @pointercancel="stopDragging"
  >
    <div ref="cardEl" class="draggableCard" :class="{ wide: cardVariant === 'wide', large: cardVariant === 'large', resizableCard: resizable }" :style="cardStyle">
      <slot />
      <div
        v-if="resizable"
        class="resizeHandle"
        @pointerdown="onResizePointerDown"
        @pointermove="onResizePointerMove"
        @pointerup="onResizePointerUp"
        @pointercancel="onResizePointerUp"
      ></div>
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
  background: rgba(15, 23, 42, 0.18);
  z-index: 9999;
}

.draggableOverlay.isDragging,
.draggableOverlay.isResizing {
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

.draggableCard.large.resizableCard {
  height: 88vh;
}

:deep([data-drag-handle]) {
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.isDragging :deep([data-drag-handle]) {
  cursor: grabbing;
}

.resizeHandle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 20px;
  height: 20px;
  cursor: nwse-resize;
  z-index: 1;
}

.resizeHandle::after {
  content: "";
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 8px;
  height: 8px;
  border-right: 2px solid rgba(148, 163, 184, 0.5);
  border-bottom: 2px solid rgba(148, 163, 184, 0.5);
  border-radius: 0 0 2px 0;
}

.resizeHandle:hover::after {
  border-color: rgba(100, 116, 139, 0.7);
}
</style>
