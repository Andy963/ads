<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ApiClient } from "../api/client";
import type { ModelConfig, StoredRoleProfileValue } from "../api/types";
import { isTextInputElement } from "../lib/dom";
import SettingsSheet from "./SettingsSheet.vue";
import "./modelSettings.css";

type RoleProfile = { id: string; role: StoredRoleProfileValue; model_id: string; reasoning_effort: string; system_prompt: string };
const props = defineProps<{ api: ApiClient }>();
const emit = defineEmits<{ (e: "changed"): void }>();
const profiles = ref<RoleProfile[]>([]);
const models = ref<ModelConfig[]>([]);
const selected = ref<StoredRoleProfileValue>("acopilot");
const baselines = ref<Record<string, RoleProfile>>({});
const busy = ref(false);
const error = ref("");
const message = ref("");
const picker = ref<"model" | "effort" | null>(null);
const panel = ref<HTMLElement | null>(null);
const keyboardOpen = ref(false);
let viewport: VisualViewport | null = null;
let media: MediaQueryList | null = null;
let revealTimer: number | null = null;
function updateKeyboard(): void {
  const element = panel.value;
  const active = document.activeElement;
  keyboardOpen.value = Boolean(media?.matches && viewport && element && active instanceof HTMLElement
    && element.contains(active) && isTextInputElement(active) && window.innerHeight - viewport.height * viewport.scale > 120);
  if (revealTimer !== null) window.clearTimeout(revealTimer);
  revealTimer = null;
  if (!keyboardOpen.value) return;
  revealTimer = window.setTimeout(() => {
    revealTimer = null;
    if (!element || !(document.activeElement instanceof HTMLTextAreaElement)) return;
    const bounds = element.getBoundingClientRect();
    const editor = document.activeElement.getBoundingClientRect();
    const actions = element.querySelector(".lanePromptActions")?.getBoundingClientRect();
    const bottom = Math.min(bounds.bottom, actions?.top ?? bounds.bottom);
    element.scrollTop += editor.bottom > bottom ? editor.bottom - bottom : Math.min(0, editor.top - bounds.top);
  }, 300);
}
const current = computed(() => profiles.value.find((profile) => profile.role === selected.value));
const dirty = computed(() => current.value && current.value.system_prompt !== baselines.value[current.value.id]?.system_prompt);
const selectedModel = computed(() => {
  const reference = current.value?.model_id;
  const exact = models.value.find(model => model.id === reference);
  const legacy = models.value.filter(model => model.modelId === reference);
  return exact ?? (legacy.length === 1 ? legacy[0] : undefined);
});
const efforts = computed(() => current.value?.reasoning_effort === "low" ? ["low", "medium", "high"] : ["medium", "high"]);
const roles = [{ id: "acopilot", label: "Acopilot" }, { id: "developer", label: "Developer" }, { id: "reviewer", label: "Reviewer" }] as const;
let swipe: { identifier: number; x: number; y: number; role: StoredRoleProfileValue; horizontal: boolean } | null = null;
let suppressClickUntil = 0;
watch([busy, picker, selected], () => { swipe = null; });

function startSwipe(event: TouchEvent): void {
  swipe = null;
  suppressClickUntil = 0;
  if (!media?.matches || busy.value || picker.value || event.touches.length !== 1) return;
  const target = event.target;
  // Editing, text selection and actionable rows keep their native gestures.
  if (target instanceof Element && target.closest("textarea, input, select, [contenteditable], a, button:not(.lanePromptLane)")) return;
  const touch = event.touches[0];
  // Leave screen-edge navigation to the app drawer and the browser.
  if (touch.clientX <= 32 || touch.clientX >= window.innerWidth - 32) return;
  swipe = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, role: selected.value, horizontal: false };
}
function moveSwipe(event: TouchEvent): void {
  if (!swipe) return;
  if (event.touches.length !== 1 || event.touches[0].identifier !== swipe.identifier) { swipe = null; return; }
  const dx = Math.abs(event.touches[0].clientX - swipe.x);
  const dy = Math.abs(event.touches[0].clientY - swipe.y);
  if (!swipe.horizontal && Math.max(dx, dy) >= 10) {
    if (dx <= dy * 1.3) { swipe = null; return; }
    swipe.horizontal = true;
  }
  if (swipe.horizontal && event.cancelable) event.preventDefault();
}
function endSwipe(event: TouchEvent): void {
  const gesture = swipe;
  swipe = null;
  if (!gesture || busy.value || picker.value || event.touches.length) return;
  const touch = Array.from(event.changedTouches).find(item => item.identifier === gesture.identifier);
  if (!touch) return;
  const dx = touch.clientX - gesture.x;
  const dy = touch.clientY - gesture.y;
  if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy) * 1.3) return;
  if (event.cancelable) event.preventDefault();
  suppressClickUntil = Date.now() + 400;
  const index = roles.findIndex(role => role.id === gesture.role);
  const next = roles[index + (dx < 0 ? 1 : -1)];
  if (next) selected.value = next.id;
}
function guardSwipeClick(event: MouseEvent): void {
  if (event.detail && Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
}
watch(selected, () => { error.value = ""; message.value = ""; });
async function load(): Promise<void> {
  busy.value = true;
  try {
    const [saved, enabled] = await Promise.all([props.api.get<RoleProfile[]>("/api/role-profiles"), props.api.get<ModelConfig[]>("/api/models")]);
    models.value = enabled;
    profiles.value = saved;
    baselines.value = Object.fromEntries(saved.map(profile => [profile.id, { ...profile }]));
  } catch (err) { error.value = err instanceof Error ? err.message : "Could not load roles."; }
  finally { busy.value = false; }
}
async function persist(changes: Partial<Pick<RoleProfile, "model_id" | "reasoning_effort" | "system_prompt">>): Promise<boolean> {
  if (!current.value || busy.value) return false;
  busy.value = true;
  error.value = "";
  message.value = "";
  const profile = current.value;
  const promptDraft = profile.system_prompt;
  try {
    const saved = await props.api.put<RoleProfile>(`/api/role-profiles/${encodeURIComponent(profile.id)}`, changes);
    Object.assign(profile, saved);
    baselines.value[profile.id] = { ...saved };
    // Saving a model or effort must not commit or discard the instruction draft.
    if (changes.system_prompt === undefined) profile.system_prompt = promptDraft;
    message.value = changes.system_prompt !== undefined ? "Instructions saved. New turns use this configuration." : "Selection saved. New turns use this configuration.";
    emit("changed");
    return true;
  } catch (err) { error.value = err instanceof Error ? err.message : "Could not save role."; return false; }
  finally { busy.value = false; }
}
async function save(): Promise<void> {
  if (current.value && dirty.value && current.value.system_prompt.trim()) await persist({ system_prompt: current.value.system_prompt });
}
async function choose(value: string): Promise<void> {
  const changes = picker.value === "model" ? { model_id: value } : { reasoning_effort: value };
  if (await persist(changes)) picker.value = null;
}
function openPicker(kind: "model" | "effort"): void {
  error.value = "";
  message.value = "";
  picker.value = kind;
}
function reset(): void {
  if (current.value) current.value.system_prompt = baselines.value[current.value.id].system_prompt;
  error.value = "";
  message.value = "";
}
onMounted(() => {
  void load();
  viewport = window.visualViewport ?? null;
  media = window.matchMedia?.("(max-width: 900px)") ?? null;
  viewport?.addEventListener("resize", updateKeyboard);
  viewport?.addEventListener("scroll", updateKeyboard);
  media?.addEventListener("change", updateKeyboard);
});
onBeforeUnmount(() => {
  if (revealTimer !== null) window.clearTimeout(revealTimer);
  viewport?.removeEventListener("resize", updateKeyboard);
  viewport?.removeEventListener("scroll", updateKeyboard);
  media?.removeEventListener("change", updateKeyboard);
});
</script>

<template>
  <section ref="panel" class="iosSettings lanePromptPanel" :class="{ 'lanePromptPanel--keyboard-open': keyboardOpen }" :aria-busy="busy" data-testid="lane-prompt-panel"
    @focusin="updateKeyboard" @focusout="updateKeyboard" @touchstart.passive="startSwipe" @touchmove="moveSwipe" @touchend="endSwipe" @touchcancel="swipe = null" @click.capture="guardSwipeClick">
    <nav class="lanePromptLaneSelector" aria-label="Role">
      <button v-for="role in roles" :key="role.id" type="button" class="lanePromptLane" :class="{ active: selected === role.id }" :aria-pressed="selected === role.id" :disabled="busy" :data-testid="`lane-prompt-lane-${role.id === 'developer' ? 'actions' : role.id}`" @click="selected = role.id">{{ role.label }}</button>
    </nav>
    <p v-if="error && !picker" class="settingsFeedback" role="alert" data-testid="lane-prompt-error">{{ error }}</p>
    <p v-if="message" class="settingsFeedback" role="status" data-testid="lane-prompt-status">{{ message }}</p>
    <template v-if="current">
      <label class="lanePromptField"><span class="settingsBlockTitle">System instructions</span><textarea v-model="current.system_prompt" class="lanePromptTextarea" aria-label="System instructions" data-testid="lane-prompt-editor" maxlength="100000" :disabled="busy" /></label>
      <div class="roleControlsBar settingsBlock">
        <h2 class="settingsBlockTitle">Model settings</h2>
        <div class="settingsList">
          <button type="button" class="settingsRow" data-testid="role-model-select" :disabled="busy" @click="openPicker('model')">
            <span class="settingsRowContent"><span>Model</span><small class="settingsDetail">{{ selectedModel ? (selectedModel.displayName || selectedModel.modelId) : 'Choose an enabled conversation model' }}<template v-if="selectedModel"> · {{ selectedModel.provider }}</template></small></span><span class="settingsChevron" aria-hidden="true">›</span>
          </button>
          <button type="button" class="settingsRow" data-testid="role-effort-select" :disabled="busy" @click="openPicker('effort')">
            <span class="settingsRowContent"><span>Reasoning effort</span><small class="settingsDetail effortLabel">{{ current.reasoning_effort }}</small></span><span class="settingsChevron" aria-hidden="true">›</span>
          </button>
        </div>
        <p class="settingsNote">Model and effort selections save automatically. Instructions are saved separately.</p>
      </div>
      <div class="lanePromptActions">
        <button type="button" class="roleDiscard" data-testid="lane-prompt-reset" :disabled="busy || !dirty" @click="reset">Discard</button>
        <button type="button" class="settingsPrimary" data-testid="lane-prompt-save" :disabled="busy || !dirty || !current.system_prompt.trim()" @click="save">{{ busy ? 'Saving…' : 'Save instructions' }}</button>
      </div>
    </template>
    <SettingsSheet v-if="picker && current" :title="picker === 'model' ? 'Role model' : 'Reasoning effort'" :busy="busy" test-id="role-selection-sheet" @close="picker = null">
      <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
      <div v-if="picker === 'model'" class="settingsBlock settingsList">
        <button v-for="model in models" :key="model.id" type="button" class="settingsRow" :disabled="busy" :aria-pressed="selectedModel?.id === model.id" :data-testid="'role-model-' + model.id" @click="choose(model.id)">
          <span class="settingsRowContent"><span>{{ model.displayName || model.modelId }}</span><small class="settingsDetail">{{ model.provider }}</small></span>
          <span class="settingsCheckmark" aria-hidden="true">{{ selectedModel?.id === model.id ? '✓' : '' }}</span>
        </button>
      </div>
      <div v-else class="settingsBlock settingsList">
        <button v-for="effort in efforts" :key="effort" type="button" class="settingsRow effortLabel" :disabled="busy" :aria-pressed="current.reasoning_effort === effort" :data-testid="'role-effort-' + effort" @click="choose(effort)">
          <span class="settingsRowContent">{{ effort }}</span><span class="settingsCheckmark" aria-hidden="true">{{ current.reasoning_effort === effort ? '✓' : '' }}</span>
        </button>
      </div>
      <p v-if="picker === 'model' && !models.length" class="settingsNote">Enable conversation models in Models → Chat first. You can still save instructions.</p>
      <p class="settingsNote">Choose a row to save. Cancel keeps the current selection.</p>
    </SettingsSheet>
  </section>
</template>

<style scoped>
.lanePromptPanel { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1; gap: 16px; overflow: auto; padding: 12px 16px; background: var(--settings-background); overscroll-behavior: contain; }
.lanePromptLaneSelector { display: flex; flex: 0 0 auto; gap: 2px; padding: 3px; border-radius: 11px; background: var(--segmented-bg); }
.lanePromptLane { flex: 1; min-width: 0; min-height: 44px; padding: 8px 4px; border: 0; border-radius: 8px; background: none; font-size: 14px; color: inherit; }
.lanePromptLane.active { background: var(--settings-surface); box-shadow: 0 1px 3px #0002; font-weight: 600; }
.roleControlsBar.settingsBlock { margin: 0; flex: 0 0 auto; }
.lanePromptField { display: flex; flex-direction: column; flex: 1 0 auto; min-height: 160px; }
.lanePromptTextarea { width: 100%; flex: 1; min-height: 240px; resize: vertical; box-sizing: border-box; font-size: 16px; line-height: 20px; padding: 12px 16px; border: 0; border-radius: 12px; background: var(--settings-surface); color: var(--settings-text); }
.lanePromptTextarea:focus-visible { outline: 2px solid var(--settings-tint); outline-offset: -2px; }
.effortLabel { text-transform: capitalize; }
.lanePromptActions { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; position: sticky; bottom: 0; background: var(--settings-background); padding: 8px 0 max(8px, env(safe-area-inset-bottom, 0px)); }
.lanePromptActions .settingsPrimary { width: auto; flex: 1; min-height: 44px; font-size: 16px; }
.roleDiscard { min-height: 44px; padding: 8px 12px; border: 0; background: none; color: var(--settings-tint); font-size: 16px; }
.settingsFeedback { flex: 0 0 auto; margin: 0; }
@media (max-width: 900px) {
  .lanePromptPanel { padding: 8px 12px; gap: 10px; }
  .lanePromptLaneSelector { padding: 2px; border-radius: 9px; }
  .lanePromptLane { min-height: 32px; padding: 4px; border-radius: 7px; }
  .lanePromptTextarea { padding: 10px 12px; }
  .lanePromptPanel--keyboard-open { gap: 4px; padding-block: 4px; }
  .lanePromptPanel--keyboard-open .lanePromptField > span { display: none; }
  .lanePromptPanel--keyboard-open .roleControlsBar { display: none; }
  .lanePromptPanel--keyboard-open .lanePromptField { flex: 1; min-height: 0; }
  .lanePromptPanel--keyboard-open .lanePromptTextarea { flex: 1 1 auto; min-height: 0; }
  .lanePromptPanel--keyboard-open .lanePromptActions { bottom: 0; margin: 6px 0 0; padding: 4px 0; }
  .lanePromptPanel--keyboard-open [role="status"] { display: none; }
}
</style>
