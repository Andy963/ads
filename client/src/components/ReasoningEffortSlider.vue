<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{
  options: Array<{ id: string; label: string }>;
  modelValue: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ (event: "change", value: string): void }>();
const preview = ref<number | null>(null);
const selectedIndex = computed(() => Math.max(0, props.options.findIndex(option => option.id === props.modelValue)));
const currentIndex = computed(() => preview.value ?? selectedIndex.value);
const currentLabel = computed(() => props.options[currentIndex.value]?.label ?? "Not available");
const progress = computed(() => props.options.length > 1 ? 100 * currentIndex.value / (props.options.length - 1) : 0);
watch(() => [props.modelValue, props.options.map(option => option.id).join("\n"), props.disabled], () => { preview.value = null; });

function readIndex(event: Event): number | null {
  if (props.disabled || props.options.length < 2) return null;
  const index = Number((event.target as HTMLInputElement).value);
  return Number.isInteger(index) && index >= 0 && index < props.options.length ? index : null;
}
function updatePreview(event: Event): void { preview.value = readIndex(event); }
function commit(event: Event): void {
  const index = readIndex(event);
  preview.value = null;
  if (index !== null && props.options[index].id !== props.modelValue) emit("change", props.options[index].id);
}
function cancel(event: Event): void {
  preview.value = null;
  (event.target as HTMLInputElement).value = String(selectedIndex.value);
}
</script>

<template>
  <div class="effortControl" :style="{ '--effort-progress': progress + '%' }">
    <div class="effortHeading"><span>Reasoning effort</span><output data-testid="effort-slider-value" aria-live="off">{{ currentLabel }}</output></div>
    <input type="range" class="effortRange" data-testid="reasoning-effort-slider" aria-label="Reasoning effort"
      :aria-valuetext="currentLabel" :min="0" :max="Math.max(1, options.length - 1)" :step="1" :value="currentIndex"
      :disabled="disabled || options.length < 2" @input="updatePreview" @change="commit" @pointercancel="cancel" />
    <div class="effortTicks" aria-hidden="true">
      <span v-for="(option, index) in options" :key="option.id" :data-effort="option.id" :class="{ selected: index === currentIndex }">
        <i /><small v-if="options.length <= 5 || index === 0 || index === options.length - 1">{{ option.label }}</small>
      </span>
    </div>
  </div>
</template>

<style scoped>
.effortControl { padding: 16px; }
.effortHeading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 17px; }
.effortHeading output { color: var(--settings-tint); font-size: 15px; font-weight: 600; }
.effortRange { display: block; -webkit-appearance: none; appearance: none; width: 100%; height: 44px; margin: 8px 0 0; padding: 0; border: 0; background: transparent; cursor: pointer; accent-color: var(--settings-tint); touch-action: pan-y; }
.effortRange::-webkit-slider-runnable-track { height: 4px; border-radius: 4px; background: linear-gradient(to right, var(--settings-tint) var(--effort-progress), #d1d1d6 var(--effort-progress)); }
.effortRange::-moz-range-track { height: 4px; border-radius: 4px; background: #d1d1d6; }
.effortRange::-moz-range-progress { height: 4px; border-radius: 4px; background: var(--settings-tint); }
.effortRange::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 28px; height: 28px; margin-top: -12px; border: .5px solid #0001; border-radius: 50%; background: white; box-shadow: 0 2px 5px #0003; }
.effortRange::-moz-range-thumb { width: 28px; height: 28px; border: .5px solid #0001; border-radius: 50%; background: white; box-shadow: 0 2px 5px #0003; }
.effortRange:focus-visible { outline: 2px solid var(--settings-tint); outline-offset: 2px; border-radius: 6px; }
.effortRange:disabled { opacity: .5; cursor: default; }
.effortTicks { display: flex; justify-content: space-between; margin: 0 14px; min-height: 28px; }
.effortTicks > span { display: flex; flex-direction: column; align-items: center; position: relative; width: 0; color: var(--settings-secondary); }
.effortTicks i { width: 1px; height: 5px; background: #c7c7cc; }
.effortTicks small { margin-top: 4px; font-size: 11px; white-space: nowrap; }
.effortTicks > span:first-child small { align-self: flex-start; margin-left: -12px; }
.effortTicks > span:last-child small { align-self: flex-end; margin-right: -12px; }
.effortTicks .selected { color: var(--settings-tint); }
</style>
