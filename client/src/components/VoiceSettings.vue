<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ApiClient } from "../api/client";
import ModelServicePicker from "./ModelServicePicker.vue";
import SettingsSheet from "./SettingsSheet.vue";
import type { VoiceConfig, VoiceSettingsResponse, VoiceTranscriptionResponse } from "../../../shared/voice";
import { DEFAULT_CORRECTION_SYSTEM_PROMPT } from "../../../shared/voice";

const props = withDefaults(defineProps<{ api: ApiClient; section?: "transcription" | "correction" }>(), { section: "transcription" });
const emit = defineEmits<{ (e: "changed"): void }>();
const saved = ref<VoiceSettingsResponse | null>(null);
const config = ref<VoiceConfig | null>(null);
const busy = ref(false);
const error = ref("");
const message = ref("");
const optionsOpen = ref(false);
const testOpen = ref(false);
const editor = ref<HTMLFormElement | null>(null);
const sample = ref<File | null>(null);
const testing = ref(false);
const result = ref<VoiceTranscriptionResponse | null>(null);
let testController: AbortController | null = null;
let disposed = false;
const isCorrection = computed(() => props.section === "correction");
const title = computed(() => isCorrection.value ? "Correction" : "Transcription");
function copyConfig(value: VoiceConfig): VoiceConfig {
  return { ...value, transcription: { ...value.transcription }, correction: { ...value.correction } };
}
function sectionConfig(value: VoiceConfig) {
  if (isCorrection.value) return value.correction;
  return { enabled: value.enabled, transcription: value.transcription, totalTimeoutMs: value.totalTimeoutMs };
}
const dirty = computed(() => Boolean(config.value && saved.value
  && JSON.stringify(sectionConfig(config.value)) !== JSON.stringify(sectionConfig(saved.value.config))));

async function load(): Promise<void> {
  busy.value = true;
  try {
    const value = await props.api.get<VoiceSettingsResponse>("/api/voice/settings");
    if (disposed) return;
    saved.value = value;
    config.value = copyConfig(value.config);
  } catch { if (!disposed) error.value = "Could not load settings. Please try again."; }
  finally { busy.value = false; }
}
function openOptions(): void {
  if (!saved.value) return;
  config.value = copyConfig(saved.value.config);
  error.value = "";
  optionsOpen.value = true;
}
function closeOptions(): void {
  optionsOpen.value = false;
  if (saved.value) config.value = copyConfig(saved.value.config);
}
async function save(resetOptions = false): Promise<boolean> {
  if (!config.value || busy.value) return false;
  if (saved.value?.recoveryRequired && !resetOptions) {
    error.value = "Saved voice options are corrupt. Recover them explicitly before saving.";
    return false;
  }
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await props.api.put<VoiceSettingsResponse>(isCorrection.value ? "/api/voice/correction" : "/api/voice/settings", {
      config: sectionConfig(config.value), ...(resetOptions ? { resetOptions: true } : {}),
    });
    if (disposed) return false;
    saved.value = value;
    config.value = copyConfig(value.config);
    optionsOpen.value = false;
    message.value = "Settings saved.";
    emit("changed");
    return true;
  } catch (err) {
    if (!disposed) error.value = err instanceof Error ? err.message : "Could not save settings.";
    return false;
  } finally { busy.value = false; }
}
async function submitOptions(): Promise<void> {
  if (editor.value && !editor.value.reportValidity()) return;
  await save();
}
async function toggleEnabled(checked: boolean): Promise<void> {
  if (!config.value || !saved.value || busy.value) return;
  if (isCorrection.value) config.value.correction.enabled = checked;
  else config.value.enabled = checked;
  if (!await save()) config.value = copyConfig(saved.value.config);
}
function cancelTest(): void { testController?.abort(); testController = null; testing.value = false; }
function closeTest(): void { cancelTest(); testOpen.value = false; sample.value = null; result.value = null; }
function selectSample(event: Event): void {
  cancelTest();
  sample.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  result.value = null;
}
async function testTranscription(): Promise<void> {
  if (!sample.value || !saved.value?.configured || !saved.value.config.enabled) return;
  cancelTest();
  const controller = new AbortController();
  testController = controller;
  testing.value = true;
  result.value = null;
  error.value = "";
  try {
    const response = await fetch("/api/audio/transcriptions", {
      method: "POST", credentials: "include", headers: { "Content-Type": sample.value.type }, body: sample.value, signal: controller.signal,
    });
    const payload = await response.json();
    if (controller.signal.aborted || disposed) return;
    if (!response.ok || payload.ok !== true) { error.value = payload.error || "Transcription test failed."; return; }
    result.value = payload;
  } catch { if (!controller.signal.aborted && !disposed) error.value = "Transcription test failed. Check the connection and try again."; }
  finally { if (testController === controller) { testController = null; testing.value = false; } }
}
onMounted(load);
onBeforeUnmount(() => { disposed = true; sample.value = null; cancelTest(); });
</script>

<template>
  <section class="voiceSettings" :aria-label="title" :data-testid="isCorrection ? 'correction-settings' : 'voice-settings'">
    <ModelServicePicker v-if="config" :api="api" :service="section" @changed="load(); emit('changed')" />
    <p v-if="error && !optionsOpen && !testOpen" class="settingsFeedback" role="alert">{{ error }}</p>
    <p v-if="message" class="settingsFeedback" role="status">{{ message }}</p>
    <p v-if="!config && !error" class="settingsNote">Loading…</p>
    <template v-if="config">
      <div class="settingsBlock">
        <h2 class="settingsBlockTitle">Options</h2>
        <div class="settingsList">
          <label class="settingsRow"><span class="settingsRowContent">{{ isCorrection ? 'Text correction' : 'Voice input' }}</span>
            <input class="settingsSwitch" type="checkbox" role="switch" :checked="isCorrection ? config.correction.enabled : config.enabled" :disabled="busy || saved?.recoveryRequired" :data-testid="isCorrection ? 'voice-correction-enabled' : 'voice-enabled'" @change="toggleEnabled(($event.target as HTMLInputElement).checked)" />
          </label>
          <button type="button" class="settingsRow" data-testid="voice-options-open" :disabled="busy" @click="openOptions">
            <span class="settingsRowContent"><span>{{ isCorrection ? 'Instructions & options' : 'Language & options' }}</span><small class="settingsDetail">{{ isCorrection ? 'Prompt, effort and timeout' : (config.transcription.language || 'Automatic') + ' · ' + config.transcription.timeoutMs / 1000 + 's timeout' }}</small></span><span class="settingsChevron" aria-hidden="true">›</span>
          </button>
          <button v-if="!isCorrection" type="button" class="settingsRow" data-testid="voice-test-open" @click="testOpen = true; error = ''"><span class="settingsRowContent">Test transcription</span><span class="settingsChevron" aria-hidden="true">›</span></button>
        </div>
        <p class="settingsNote">{{ isCorrection ? 'If correction fails, the original transcription is kept.' : 'Audio is sent only when you record or explicitly run a test.' }}</p>
      </div>
      <div v-if="saved?.recoveryRequired" class="settingsBlock">
        <p class="settingsNote" role="alert">Saved options are corrupt. Resetting options keeps your providers and enabled models.</p>
        <button type="button" class="settingsPrimary" data-testid="voice-reset-options" :disabled="busy" @click="save(true)">Reset voice options</button>
      </div>

      <SettingsSheet v-if="optionsOpen" :title="title + ' options'" :busy="busy" :dirty="dirty" action-label="Done" :action-disabled="!dirty || saved?.recoveryRequired" :action-test-id="isCorrection ? 'correction-save' : 'voice-save'" test-id="voice-options-sheet" @close="closeOptions" @submit="submitOptions">
        <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
        <form ref="editor" @submit.prevent="submitOptions"><fieldset :disabled="busy">
          <template v-if="isCorrection">
            <div class="settingsBlock"><h3 class="settingsBlockTitle">System instructions</h3><div class="settingsList">
              <label class="settingsField"><span>How should text be corrected?</span><textarea v-model="config.correction.systemPrompt" rows="7" maxlength="8000" required data-testid="correction-system-prompt" /></label>
              <button type="button" class="settingsRow tinted" data-testid="correction-reset-prompt" @click="config.correction.systemPrompt = DEFAULT_CORRECTION_SYSTEM_PROMPT">Restore default instructions</button>
            </div></div>
            <div class="settingsBlock settingsList">
              <label class="settingsField"><span>Reasoning effort</span><select v-model="config.correction.reasoningEffort"><option value="none">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label>
              <label class="settingsField"><span>Timeout (milliseconds)</span><input v-model.number="config.correction.timeoutMs" type="number" inputmode="numeric" min="1000" max="180000" step="1000" required /></label>
            </div>
          </template>
          <template v-else>
            <div class="settingsBlock settingsList">
              <label class="settingsField"><span>Language code · empty for automatic</span><input v-model="config.transcription.language" maxlength="16" autocapitalize="none" /></label>
              <label class="settingsField"><span>Transcription prompt</span><textarea v-model="config.transcription.prompt" maxlength="4000" rows="4" /></label>
            </div>
            <div class="settingsBlock"><h3 class="settingsBlockTitle">Timeouts</h3><div class="settingsList">
              <label class="settingsField"><span>Transcription (milliseconds)</span><input v-model.number="config.transcription.timeoutMs" type="number" inputmode="numeric" min="1000" max="180000" step="1000" required /></label>
              <label class="settingsField"><span>Total, including correction (milliseconds)</span><input v-model.number="config.totalTimeoutMs" type="number" inputmode="numeric" min="1000" max="180000" step="1000" required /></label>
            </div></div>
          </template>
        </fieldset></form>
      </SettingsSheet>

      <SettingsSheet v-if="testOpen" title="Test transcription" test-id="voice-test-sheet" @close="closeTest">
        <p class="settingsNote">Uses saved settings only. Audio is uploaded to your transcription provider; when correction is enabled, text is sent to that provider too. Charges may apply.</p>
        <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
        <div class="settingsBlock settingsList"><label class="settingsField"><span>Audio file · up to 25 MiB</span><input type="file" accept="audio/*,video/mp4" @change="selectSample" data-testid="voice-sample" /></label></div>
        <button type="button" class="settingsPrimary" :disabled="testing || busy || !sample || !saved?.configured || !saved.config.enabled" @click="testTranscription" data-testid="voice-test">{{ testing ? 'Testing…' : 'Run test' }}</button>
        <button v-if="testing" type="button" class="settingsRow tinted centered" @click="cancelTest">Cancel test</button>
        <div v-if="result" class="settingsBlock" role="status">
          <p>Transcription complete · Correction {{ result.correction.status }}</p>
          <p v-if="result.correction.warning" class="settingsNote">{{ result.correction.warning }}</p>
          <p class="transcript">{{ result.text }}</p>
          <p class="settingsNote">{{ result.timings.totalMs }} ms total</p>
        </div>
      </SettingsSheet>
    </template>
  </section>
</template>

<style scoped>
.voiceSettings { min-width: 0; }
.transcript { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 17px; }
</style>
