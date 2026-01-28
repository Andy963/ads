<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  src: string;
  href?: string;
  title?: string;
  alt?: string;
  width?: number;
  height?: number;
}>();

const failed = ref(false);
const retryNonce = ref(0);

const thumbStyle = computed(() => {
  // Allow very small thumbs for compact attachment strips.
  const w = typeof props.width === "number" && Number.isFinite(props.width) ? Math.max(10, Math.floor(props.width)) : 72;
  const h = typeof props.height === "number" && Number.isFinite(props.height) ? Math.max(10, Math.floor(props.height)) : 72;
  return { width: `${w}px`, height: `${h}px` } as const;
});

const resolvedSrc = computed(() => {
  const base = String(props.src ?? "").trim();
  if (!base) return "";
  const nonce = retryNonce.value;
  if (!nonce) return base;
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}r=${nonce}`;
});

function onError(): void {
  failed.value = true;
}

function onLoad(): void {
  failed.value = false;
}

function retry(ev?: Event): void {
  ev?.preventDefault();
  ev?.stopPropagation();
  retryNonce.value += 1;
  failed.value = false;
}
</script>

<template>
  <a v-if="href" class="thumbLink" :href="href" target="_blank" rel="noreferrer">
    <div class="thumb" :class="{ failed }" :title="title || ''" :style="thumbStyle">
      <img
        v-if="resolvedSrc && !failed"
        class="img"
        :src="resolvedSrc"
        :alt="alt || ''"
        loading="lazy"
        decoding="async"
        @error="onError"
        @load="onLoad"
      />
      <div v-else class="fallback">
        <span class="fallbackText">Image</span>
        <button class="retry" type="button" @click="retry">Retry</button>
      </div>
    </div>
  </a>
  <div v-else class="thumb" :class="{ failed }" :title="title || ''" :style="thumbStyle">
    <img
      v-if="resolvedSrc && !failed"
      class="img"
      :src="resolvedSrc"
      :alt="alt || ''"
      loading="lazy"
      decoding="async"
      @error="onError"
      @load="onLoad"
    />
    <div v-else class="fallback">
      <span class="fallbackText">Image</span>
      <button class="retry" type="button" @click="retry">Retry</button>
    </div>
  </div>
</template>

<style scoped>
.thumbLink {
  display: inline-flex;
  text-decoration: none;
  color: inherit;
}
.thumb {
  border-radius: 12px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: rgba(248, 250, 252, 0.9);
  overflow: hidden;
  position: relative;
  box-sizing: border-box;
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  gap: 6px;
  padding: 10px;
  box-sizing: border-box;
  color: #64748b;
}
.fallbackText {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.retry {
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid rgba(148, 163, 184, 0.75);
  background: white;
  color: #0f172a;
}
.retry:hover {
  border-color: rgba(37, 99, 235, 0.6);
}
</style>
