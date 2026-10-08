<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import "./modelSettings.css";

const props = withDefaults(defineProps<{
  title: string;
  busy?: boolean;
  dirty?: boolean;
  actionLabel?: string;
  actionDisabled?: boolean;
  destructive?: boolean;
  testId?: string;
  actionTestId?: string;
  closeLabel?: string;
}>(), { actionLabel: "", testId: "settings-sheet", actionTestId: "sheet-done", closeLabel: "Cancel" });
const emit = defineEmits<{ (event: "close"): void; (event: "submit"): void }>();
const dialog = ref<HTMLDialogElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const discard = ref(false);
let previousFocus: HTMLElement | null = null;
let backdropPointer = false;

function requestClose(): void {
  if (props.busy) return;
  if (props.dirty) discard.value = true;
  else emit("close");
}
function cancel(): void {
  if (discard.value) discard.value = false;
  else requestClose();
}
function keydown(event: KeyboardEvent): void {
  // Do not let the desktop settings container handle this modal's Escape.
  event.stopPropagation();
  if (event.key === "Escape") { event.preventDefault(); cancel(); }
}
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof dialog.value?.showModal === "function") dialog.value.showModal();
  else dialog.value?.setAttribute("open", "");
  await nextTick();
  // Opening an editor should not immediately open the iOS keyboard.
  heading.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  dialog.value?.close?.();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="iosSettings settingsSheet" :aria-label="discard ? 'Discard changes?' : title" aria-modal="true" :data-testid="testId"
      @keydown="keydown" @cancel.prevent="cancel" @pointerdown="backdropPointer = $event.target === $event.currentTarget"
      @click.self="backdropPointer && requestClose()">
      <div class="sheetPanel">
        <header class="sheetNavigation">
          <button v-if="discard || (closeLabel && closeLabel.trim())" type="button" class="sheetNavigationButton" :disabled="busy" data-testid="sheet-cancel" @click="cancel">{{ discard ? 'Keep editing' : closeLabel }}</button>
          <span v-else />
          <h2 ref="heading" tabindex="-1" autofocus>{{ discard ? 'Discard changes?' : title }}</h2>
          <button v-if="actionLabel && !discard" type="button" class="sheetNavigationButton sheetDone" :class="{ destructive }" :disabled="busy || actionDisabled" :data-testid="actionTestId" @click="emit('submit')">{{ busy ? 'Saving…' : actionLabel }}</button>
          <span v-else />
        </header>
        <div class="sheetBody settingsScrollArea">
          <div v-if="discard" class="settingsBlock">
            <p class="settingsNote">Your changes have not been saved.</p>
            <div class="settingsList"><button type="button" class="settingsRow destructive centered" data-testid="sheet-discard" @click="emit('close')">Discard changes</button></div>
          </div>
          <div v-show="!discard"><slot /></div>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.settingsSheet { position: fixed; inset: var(--app-top, 0px) 0 auto; margin: 0; width: 100%; height: var(--ads-visual-viewport-height, 100dvh); max-width: none; max-height: none; padding: 24px; border: 0; background: transparent; overflow: hidden; overscroll-behavior: none; }
.settingsSheet[open] { display: flex; align-items: center; justify-content: center; }
.settingsSheet::backdrop { background: rgba(0, 0, 0, .35); }
.sheetPanel { display: flex; flex-direction: column; width: min(560px, 100%); max-height: 100%; min-height: 0; background: var(--settings-background); border-radius: 16px; overflow: hidden; box-shadow: 0 20px 80px #0002; }
.sheetNavigation { display: grid; grid-template-columns: minmax(72px, 1fr) minmax(0, 2fr) minmax(72px, 1fr); align-items: center; flex: 0 0 auto; min-height: 56px; padding: 4px 8px; background: var(--settings-surface); border-bottom: .5px solid var(--settings-separator); }
.sheetNavigation h2 { margin: 0; text-align: center; font-size: 17px; font-weight: 600; outline: none; overflow-wrap: anywhere; }
.sheetNavigationButton { background: none; border: 0; padding: 10px 8px; min-height: 44px; color: var(--settings-tint); font-size: 17px; text-align: left; }
.sheetDone { text-align: right; font-weight: 600; }
.sheetBody { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px max(16px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px)); scroll-padding-block: 20px; }
@media (max-width: 900px) {
  .settingsSheet { padding: max(12px, env(safe-area-inset-top, 0px)) 0 0; }
  .settingsSheet[open] { align-items: flex-end; }
  .sheetPanel { width: 100%; border-radius: 16px 16px 0 0; }
}
</style>
