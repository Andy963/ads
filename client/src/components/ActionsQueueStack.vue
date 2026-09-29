<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { formatBlockedDuration, type ActionJobQueueItem } from "../lib/actionJobs";

// Vertical travel that takes the axis lock and starts 1:1 card tracking.
const DRAG_LOCK_PX = 8;
// Release distance that settles one card forward/backward.
const SETTLE_DISTANCE_PX = 40;
// Release velocity (px/ms, ~350px/s) that settles one card regardless of distance.
const FLICK_VELOCITY_PX_PER_MS = 0.35;
// A finger held still before release must not read as a flick.
const FLICK_STALE_MS = 100;
// Bounded occluded edges rendered behind the front card, regardless of queue depth.
const MAX_PEEK = 3;
// Visible edge height per occluded card.
const PEEK_OFFSET_PX = 6;
// Resistance factor when dragging past the first/last card.
const RUBBER_BAND = 0.35;
// Matches the settle transition in the scoped styles.
const SETTLE_MS = 180;
// How long the click that follows a completed drag stays swallowed.
const CLICK_SUPPRESS_MS = 700;

const props = defineProps<{
  jobs: ActionJobQueueItem[];
  /** Execution-active job (first non-queued job), used only for the default selection. */
  activeJobId: string | null;
  starting: boolean;
  /** Changes on project/account switch: resets selection and cancels gestures. */
  resetKey: string;
}>();

const emit = defineEmits<{
  (e: "start"): void;
  (e: "cancel", jobId: string): void;
  (e: "resolve", jobId: string, action: string): void;
}>();

const BLOCKED_RESOLVE_ACTIONS = [
  { action: "dismiss", label: "Dismiss" },
] as const;

// --- Selection: browsing identity is a stable job id, not an index ---------

const selectedId = ref<string | null>(null);
// Last resolved position of the selected job; drives the neighbor fallback
// when that job leaves the queue.
let lastFrontIndex = 0;

function defaultSelectionId(jobs: ActionJobQueueItem[]): string | null {
  if (!jobs.length) return null;
  if (props.activeJobId && jobs.some((job) => job.id === props.activeJobId)) return props.activeJobId;
  return jobs[0]?.id ?? null;
}

watch(() => [props.jobs, props.activeJobId] as const, ([jobs]) => {
  if (!jobs.length) {
    selectedId.value = null;
    lastFrontIndex = 0;
    return;
  }
  const currentIndex = jobs.findIndex((job) => job.id === selectedId.value);
  if (currentIndex >= 0) {
    // Status updates and newly queued jobs must not snap a browsing selection.
    lastFrontIndex = currentIndex;
    return;
  }
  if (selectedId.value) {
    // The selected job left the queue: take the job that slid into its slot,
    // or the previous neighbour when it was the last card.
    const fallback = jobs[Math.min(lastFrontIndex, jobs.length - 1)] ?? jobs[0];
    selectedId.value = fallback?.id ?? null;
    lastFrontIndex = fallback ? jobs.indexOf(fallback) : 0;
    return;
  }
  selectedId.value = defaultSelectionId(jobs);
  lastFrontIndex = Math.max(0, jobs.findIndex((job) => job.id === selectedId.value));
}, { immediate: true });

watch(() => props.resetKey, () => {
  cancelGesture();
  selectedId.value = defaultSelectionId(props.jobs);
  lastFrontIndex = Math.max(0, props.jobs.findIndex((job) => job.id === selectedId.value));
});

const frontIndex = computed(() => {
  const index = props.jobs.findIndex((job) => job.id === selectedId.value);
  return index >= 0 ? index : 0;
});
const frontJob = computed(() => props.jobs[frontIndex.value] ?? null);

function selectByIndex(index: number): void {
  const clamped = Math.max(0, Math.min(props.jobs.length - 1, index));
  const job = props.jobs[clamped];
  if (!job) return;
  selectedId.value = job.id;
  lastFrontIndex = clamped;
}

// --- Bounded stack window ---------------------------------------------------

const previousJob = computed(() => (frontIndex.value > 0 ? props.jobs[frontIndex.value - 1] : null));
const nextPeeks = computed(() => props.jobs.slice(frontIndex.value + 1, frontIndex.value + 1 + MAX_PEEK));

const windowStyle = computed<Record<string, string>>(() => ({
  paddingTop: previousJob.value ? `${PEEK_OFFSET_PX}px` : "0px",
  paddingBottom: `${nextPeeks.value.length * PEEK_OFFSET_PX}px`,
}));

const previousPeekStyle = computed<Record<string, string | number>>(() => ({
  top: "0px",
  bottom: `${nextPeeks.value.length * PEEK_OFFSET_PX}px`,
  zIndex: MAX_PEEK + 1,
}));

function nextPeekStyle(index: number): Record<string, string | number> {
  const depth = index + 1;
  return {
    top: `${(previousJob.value ? PEEK_OFFSET_PX : 0) + depth * PEEK_OFFSET_PX}px`,
    bottom: `${(nextPeeks.value.length - depth) * PEEK_OFFSET_PX}px`,
    zIndex: MAX_PEEK - depth,
  };
}

// --- Vertical press-and-drag browsing ---------------------------------------

type DragSample = { y: number; time: number };

type StackGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  tracking: boolean;
  samples: DragSample[];
};

let gesture: StackGesture | null = null;
const dragOffset = ref(0);
const dragTracking = ref(false);
const settleSnapping = ref(false);
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let suppressClickUntil = 0;

const frontCardStyle = computed<Record<string, string | number>>(() => ({
  transform: dragOffset.value ? `translateY(${dragOffset.value}px)` : "none",
  zIndex: MAX_PEEK + 2,
}));

function clearSettleTimer(): void {
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

function cancelGesture(): void {
  gesture = null;
  dragTracking.value = false;
  dragOffset.value = 0;
  settleSnapping.value = false;
  clearSettleTimer();
}

function onPointerDown(ev: PointerEvent): void {
  if (gesture || ev.isPrimary === false || ev.button !== 0) return;
  gesture = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    lastY: ev.clientY,
    tracking: false,
    samples: [{ y: ev.clientY, time: performance.now() }],
  };
  // Capture on the original target keeps drags alive without retargeting a
  // stationary button click to the surrounding card.
  // jsdom lacks the capture APIs, so degrade quietly there.
  try {
    (ev.target as Element | null)?.setPointerCapture?.(ev.pointerId);
  } catch {
    // best-effort
  }
}

function resistedOffset(dy: number): number {
  const atFirst = frontIndex.value <= 0;
  const atLast = frontIndex.value >= props.jobs.length - 1;
  if ((dy > 0 && atFirst) || (dy < 0 && atLast)) return dy * RUBBER_BAND;
  return dy;
}

function onPointerMove(ev: PointerEvent): void {
  const current = gesture;
  if (!current || current.pointerId !== ev.pointerId) return;
  const dy = ev.clientY - current.startY;
  if (!current.tracking) {
    const absY = Math.abs(dy);
    const absX = Math.abs(ev.clientX - current.startX);
    if (absY < DRAG_LOCK_PX && absX < DRAG_LOCK_PX) return;
    // Horizontal movement belongs to the lane swipe; stay out of its way.
    if (absY <= absX) {
      gesture = null;
      return;
    }
    current.tracking = true;
    dragTracking.value = true;
  }
  current.lastY = ev.clientY;
  current.samples.push({ y: ev.clientY, time: performance.now() });
  if (current.samples.length > 5) current.samples.shift();
  dragOffset.value = resistedOffset(dy);
}

function suppressUpcomingClick(): void {
  suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
}

function finishGesture(cancelled: boolean): void {
  const current = gesture;
  gesture = null;
  dragTracking.value = false;
  if (!current || !current.tracking) return;
  // A completed drag must not also fire Cancel/Start/Dismiss or a link.
  suppressUpcomingClick();
  if (cancelled) {
    settleTo(0);
    return;
  }
  const distance = current.lastY - current.startY;
  const samples = current.samples;
  const now = performance.now();
  const last = samples[samples.length - 1];
  const first = samples[0];
  const stale = !last || now - last.time > FLICK_STALE_MS;
  let velocity = 0;
  if (!stale && first && last && samples.length >= 2) {
    const dt = last.time - first.time;
    if (dt > 0) velocity = (last.y - first.y) / dt;
  }
  // Drag up advances to the next job, drag down returns to the previous one.
  let step = 0;
  if (velocity <= -FLICK_VELOCITY_PX_PER_MS || distance <= -SETTLE_DISTANCE_PX) step = 1;
  else if (velocity >= FLICK_VELOCITY_PX_PER_MS || distance >= SETTLE_DISTANCE_PX) step = -1;
  settleTo(step);
}

function settleTo(step: number): void {
  const target = Math.max(0, Math.min(props.jobs.length - 1, frontIndex.value + step));
  settleSnapping.value = true;
  dragOffset.value = 0;
  selectByIndex(target);
  clearSettleTimer();
  settleTimer = setTimeout(() => {
    settleTimer = null;
    settleSnapping.value = false;
  }, SETTLE_MS);
}

function onPointerUp(ev: PointerEvent): void {
  if (!gesture || gesture.pointerId !== ev.pointerId) return;
  finishGesture(false);
}

function onPointerCancel(ev: PointerEvent): void {
  if (!gesture || gesture.pointerId !== ev.pointerId) return;
  finishGesture(true);
}

// Lost capture (or any interruption) settles the stack instead of leaving it
// between cards. Fires after pointerup too; the finished gesture is a no-op.
function onLostPointerCapture(ev: PointerEvent): void {
  if (!gesture || gesture.pointerId !== ev.pointerId) return;
  finishGesture(true);
}

function onClickCapture(ev: MouseEvent): void {
  if (ev.detail === 0) return;
  if (Date.now() < suppressClickUntil) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    selectByIndex(frontIndex.value + 1);
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    selectByIndex(frontIndex.value - 1);
  }
}

onBeforeUnmount(cancelGesture);

// --- Front card metadata -----------------------------------------------------

function cardTitle(job: ActionJobQueueItem): string {
  return `${job.issue_id ? `#${job.issue_id}: ` : ""}${job.issue_title}`;
}

const frontBlockedFor = computed(() => {
  const job = frontJob.value;
  return job?.status === "blocked"
    ? formatBlockedDuration(job.blocked_at, Date.now(), job.updated_at)
    : null;
});

// Start mirrors the queue-level FIFO start: only offered when nothing is
// executing, and the handler revalidates against the live queue at activation.
const hasActiveJob = computed(() => props.jobs.some((job) => job.status !== "queued"));
const showStart = computed(() => frontJob.value?.status === "queued" && !hasActiveJob.value);
const showCancel = computed(() =>
  Boolean(frontJob.value && ["queued", "running", "verifying", "reviewing", "waiting_merge"].includes(frontJob.value.status)),
);

const frontAriaLabel = computed(() => {
  const job = frontJob.value;
  if (!job) return "";
  const parts = [
    cardTitle(job),
    `status ${job.status.replace("_", " ")}`,
    `job ${frontIndex.value + 1} of ${props.jobs.length}`,
  ];
  if (frontBlockedFor.value) parts.push(`blocked for ${frontBlockedFor.value}`);
  if (props.jobs.length > 1) parts.push("drag or use arrow keys to browse the queue");
  return parts.join(", ");
});
</script>

<template>
  <div v-if="jobs.length" class="actionsJobBanner actionsQueueStack" data-testid="actions-job-banner">
    <div class="actionsQueueStackWindow" :style="windowStyle">
      <div
        v-if="previousJob"
        :key="`prev-${previousJob.id}`"
        class="actionsQueueCard actionsQueueCard--peek"
        :style="previousPeekStyle"
        data-testid="actions-queue-peek"
        aria-hidden="true"
        inert
      >
        <span class="actionsQueueCardPeekTitle">{{ cardTitle(previousJob) }}</span>
      </div>
      <div
        v-for="(peek, index) in nextPeeks"
        :key="peek.id"
        class="actionsQueueCard actionsQueueCard--peek"
        :style="nextPeekStyle(index)"
        data-testid="actions-queue-peek"
        aria-hidden="true"
        inert
      >
        <span class="actionsQueueCardPeekTitle">{{ cardTitle(peek) }}</span>
      </div>
      <div
        v-if="frontJob"
        class="actionsQueueCard actionsQueueCard--front"
        :class="{ 'actionsQueueCard--dragging': dragTracking, 'actionsQueueCard--settling': settleSnapping }"
        :style="frontCardStyle"
        tabindex="0"
        role="group"
        :aria-label="frontAriaLabel"
        data-testid="actions-queue-front"
        :data-job-id="frontJob.id"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @lostpointercapture="onLostPointerCapture"
        @keydown="onKeydown"
        @click.capture="onClickCapture"
      >
        <div class="actionsQueueCardMeta">
          <span v-if="showStart || showCancel || frontJob.status === 'blocked'" class="actionsJobActions">
            <button
              v-if="showStart"
              type="button"
              class="btnActionStart"
              :disabled="starting"
              data-testid="btn-action-start"
              @click="emit('start')"
            >
              {{ starting ? '启动中...' : '启动执行' }}
            </button>
            <button
              v-if="showCancel"
              type="button"
              class="btnActionCancel"
              data-testid="btn-action-cancel"
              @click="emit('cancel', frontJob.id)"
            >
              Cancel
            </button>
            <template v-if="frontJob.status === 'blocked'">
              <button
                v-for="resolve in BLOCKED_RESOLVE_ACTIONS"
                :key="resolve.action"
                type="button"
                class="btnActionCancel"
                :data-testid="`btn-action-resolve-${resolve.action}`"
                @click="emit('resolve', frontJob.id, resolve.action)"
              >
                {{ resolve.label }}
              </button>
            </template>
          </span>
          <span class="actionsJobBadge" :class="`actionsJobBadge--${frontJob.status}`">
            {{ frontJob.status.toUpperCase() }}
          </span>
          <span class="actionsQueueCardTitle" :title="cardTitle(frontJob)">
            {{ cardTitle(frontJob) }}
          </span>
        </div>
        <div v-if="frontBlockedFor" class="actionsJobBlockedFor">
          {{ `Blocked for ${frontBlockedFor}` }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.actionsJobBanner {
  margin: 8px 12px 0;
  font-size: 12.5px;
  flex-shrink: 0;
}

/* Height = the in-flow front card + the fixed peek offsets on the window's
   padding; it never grows with job count. Overflow clips the occluded cards
   so only their edges show. */
.actionsQueueStackWindow {
  position: relative;
  overflow: hidden;
}

.actionsQueueCard {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  min-width: 0;
}

.actionsQueueCard--peek {
  position: absolute;
  left: 2px;
  right: 2px;
  pointer-events: none;
  user-select: none;
  padding: 6px;
  overflow: hidden;
  background: var(--surface);
}

.actionsQueueCardPeekTitle {
  display: block;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actionsQueueCard--front {
  position: relative;
  padding: 8px 12px;
  /* Vertical drags browse the stack; horizontal panning still belongs to the
     lane/page, and the scoped value keeps iOS pull-to-refresh out of the card. */
  touch-action: pan-x;
  cursor: default;
}

.actionsQueueCard--front:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.actionsQueueCard--dragging {
  cursor: grabbing;
}

.actionsQueueCard--settling {
  transition: transform 0.18s ease;
}

@media (prefers-reduced-motion: reduce) {
  .actionsQueueCard--settling {
    transition: none;
  }
}

/* First row is inline: the actions float to the top-right corner and the badge
   sits inline before the title, so wrapped title lines reclaim full width. */
.actionsQueueCardMeta {
  display: flow-root;
  min-height: 32px;
  line-height: 1.45;
  max-height: calc(1.45em * 2 + 2px);
  overflow: hidden;
}

.actionsQueueCardMeta .actionsJobActions {
  float: right;
  margin: 0 0 2px 8px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.actionsQueueCardTitle {
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}

.actionsJobBadge {
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--muted);
  color: #fff;
  text-transform: uppercase;
  vertical-align: 1px;
}

.actionsJobBadge--running,
.actionsJobBadge--verifying,
.actionsJobBadge--reviewing {
  background: var(--accent);
}

.actionsJobBadge--waiting_merge {
  background: #10b981;
}

.actionsJobBadge--failed {
  background: var(--danger);
}

.actionsJobBadge--blocked {
  background: #d97706;
}

.actionsJobBlockedFor {
  margin-top: 2px;
  color: var(--muted-2);
  font-size: 11px;
  font-weight: 400;
}

.btnActionStart {
  padding: 4px 10px;
  min-height: 32px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  border: none;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.btnActionStart:hover {
  opacity: 0.9;
}

.btnActionCancel {
  padding: 4px 8px;
  min-height: 32px;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
}

.btnActionCancel:hover {
  color: var(--text);
  border-color: var(--text);
}
</style>
