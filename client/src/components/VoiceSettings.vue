<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ApiClient } from "../api/client";
import type { ModelProvider } from "../api/types";
import type { VoiceConfig, VoiceSettingsResponse, VoiceTranscriptionResponse } from "../../../shared/voice";
import { DEFAULT_CORRECTION_SYSTEM_PROMPT } from "../../../shared/voice";

const props = withDefaults(defineProps<{ api: ApiClient; section?: "transcription" | "correction" }>(), { section: "transcription" });
const panel = ref<HTMLElement | null>(null);
const saved = ref<VoiceSettingsResponse | null>(null);
const config = ref<VoiceConfig | null>(null);
const providers = ref<ModelProvider[]>([]);
const apiKey = ref("");
const busy = ref(false);
const error = ref("");
const message = ref("");
const sample = ref<File | null>(null);
const testing = ref(false);
const result = ref<VoiceTranscriptionResponse | null>(null);
let testController: AbortController | null = null;
let disposed = false;
let viewport: VisualViewport | null = null;
const isCorrection = computed(() => props.section === "correction");
const title = computed(() => isCorrection.value ? "文本纠错" : "语音转写");
const hasApiKey = computed(() => isCorrection.value ? saved.value?.correctionHasApiKey : saved.value?.hasApiKey);
const stageProviderId = computed({
  get: () => (isCorrection.value ? config.value?.correction.providerId : config.value?.transcription.providerId) ?? "",
  set: (value: string) => {
    if (!config.value) return;
    const stage = isCorrection.value ? config.value.correction : config.value.transcription;
    stage.providerId = value || null;
    const provider = providers.value.find((item) => item.id === value);
    if (provider) {
      stage.provider = provider.name;
      stage.baseUrl = provider.baseUrl;
    }
  },
});
const stageUsesProvider = computed(() => Boolean(stageProviderId.value));
function sectionConfig(value: VoiceConfig) {
  if (isCorrection.value) return value.correction;
  return { enabled: value.enabled, transcription: value.transcription, totalTimeoutMs: value.totalTimeoutMs };
}
const dirty = computed(() => Boolean(apiKey.value) || Boolean(config.value && saved.value
  && JSON.stringify(sectionConfig(config.value)) !== JSON.stringify(sectionConfig(saved.value.config))));

async function load(): Promise<void> {
  busy.value = true;
  try {
    const value = await props.api.get<VoiceSettingsResponse>("/api/voice/settings");
    if (disposed) return;
    saved.value = value;
    config.value = structuredClone(value.config);
  } catch { if (!disposed) error.value = "无法加载配置，请重新打开页面后重试。"; }
  finally { busy.value = false; }
}
async function save(): Promise<void> {
  if (!config.value || busy.value) return;
  if (saved.value?.recoveryRequired && !apiKey.value.trim()) {
    error.value = "请填写新密钥后保存，以明确替换损坏的配置。";
    return;
  }
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const value = await props.api.put<VoiceSettingsResponse>(isCorrection.value ? "/api/voice/correction" : "/api/voice/settings", {
      config: sectionConfig(config.value), ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    });
    apiKey.value = "";
    if (disposed) return;
    saved.value = value;
    config.value = structuredClone(value.config);
    message.value = `${title.value}设置已保存。`;
  } catch { if (!disposed) error.value = "保存失败，请检查服务地址、模型、密钥和超时设置。更换地址时必须填写新密钥。"; }
  finally { busy.value = false; }
}
function cancelTest(): void { testController?.abort(); testController = null; testing.value = false; }
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
    if (!response.ok || payload.ok !== true) { error.value = payload.error || "转写测试失败，请检查配置。"; return; }
    result.value = payload;
  } catch { if (!controller.signal.aborted && !disposed) error.value = "转写测试失败，请检查语音转写配置及网络连接。"; }
  finally { if (testController === controller) { testController = null; testing.value = false; } }
}
function revealInput(event: FocusEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement) target.scrollIntoView?.({ block: "nearest" });
}
function resizeViewport(): void {
  if (!viewport || !panel.value) return;
  const available = viewport.height + viewport.offsetTop - panel.value.getBoundingClientRect().top;
  if (available > 0) panel.value.style.maxHeight = `${available}px`;
  const active = document.activeElement;
  if (active instanceof HTMLElement && panel.value.contains(active)) active.scrollIntoView?.({ block: "nearest" });
}
onMounted(() => {
  void load();
  props.api.get<ModelProvider[]>("/api/model-providers").then((value) => { if (!disposed) providers.value = value; }).catch(() => {});
  viewport = window.visualViewport;
  viewport?.addEventListener("resize", resizeViewport);
  resizeViewport();
});
onBeforeUnmount(() => {
  disposed = true;
  viewport?.removeEventListener("resize", resizeViewport);
  apiKey.value = "";
  sample.value = null;
  cancelTest();
});
</script>

<template>
  <section ref="panel" class="voiceSettings" :aria-label="title" :data-testid="isCorrection ? 'correction-settings' : 'voice-settings'" @focusin="revealInput">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="!config && !error">正在加载配置…</p>
    <template v-if="config">
      <p>设置随账户同步，密钥仅在服务端加密保存。</p>
      <p v-if="saved?.recoveryRequired" role="alert">已保存的配置损坏。保存将重置语音转写与纠错配置，请检查表单并填写新密钥后确认保存。</p>
      <form @submit.prevent="save">
        <fieldset :disabled="busy">
          <legend>{{ title }}</legend>
          <template v-if="isCorrection">
            <label class="check"><input v-model="config.correction.enabled" type="checkbox" data-testid="voice-correction-enabled" /> 启用文本纠错</label>
            <label>服务商
              <select v-model="stageProviderId" data-testid="correction-provider">
                <option value="">手动配置</option>
                <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
              </select>
            </label>
            <template v-if="!stageUsesProvider">
              <label>服务地址<input v-model="config.correction.baseUrl" type="url" :required="config.correction.enabled" placeholder="https://api.example.com/v1" autocapitalize="off" :spellcheck="false" autocomplete="off" data-testid="correction-base-url" /></label>
              <label>API 密钥 <span>{{ hasApiKey ? '已保存，留空保留' : '尚未配置' }}</span>
                <input v-model="apiKey" type="password" autocomplete="new-password" autocapitalize="off" :spellcheck="false" data-testid="correction-api-key" />
              </label>
            </template>
            <label>模型名称<input v-model="config.correction.model" :required="config.correction.enabled" maxlength="256" autocapitalize="off" :spellcheck="false" autocomplete="off" data-testid="correction-model" /></label>
            <p v-if="!stageUsesProvider">更换服务地址时必须填写匹配的新密钥；纠错不读取对话模型、角色指令或聊天记录。</p>
            <p v-else>使用所选服务商的服务地址与密钥；纠错不读取对话模型、角色指令或聊天记录。</p>
            <label>系统提示词<textarea v-model="config.correction.systemPrompt" rows="6" maxlength="8000" required data-testid="correction-system-prompt" /></label>
            <button type="button" data-testid="correction-reset-prompt" @click="config.correction.systemPrompt = DEFAULT_CORRECTION_SYSTEM_PROMPT">恢复默认提示词</button>
            <details><summary>高级设置</summary>
              <label>纠错超时（毫秒）<input v-model.number="config.correction.timeoutMs" type="number" min="1000" max="180000" step="1000" required /></label>
              <label>思考强度<select v-model="config.correction.reasoningEffort"><option value="none">关闭</option><option value="minimal">最低</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option></select></label>
            </details>
          </template>
          <template v-else>
            <label class="check"><input v-model="config.enabled" type="checkbox" /> 启用语音输入</label>
            <label>服务商
              <select v-model="stageProviderId" data-testid="voice-provider">
                <option value="">手动配置</option>
                <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
              </select>
            </label>
            <template v-if="!stageUsesProvider">
              <label>服务商名称<input v-model="config.transcription.provider" required maxlength="128" autocapitalize="off" :spellcheck="false" autocomplete="off" placeholder="groq" data-testid="voice-provider-name" /></label>
              <label>服务地址<input v-model="config.transcription.baseUrl" type="url" required autocapitalize="off" :spellcheck="false" autocomplete="off" data-testid="voice-base-url" /></label>
              <label>API 密钥 <span>{{ hasApiKey ? '已保存，留空保留' : '尚未配置' }}</span>
                <input v-model="apiKey" type="password" autocomplete="new-password" autocapitalize="off" :spellcheck="false" data-testid="voice-api-key" />
              </label>
              <p>更换服务地址时必须填写匹配的新密钥；纠错不读取对话模型、角色指令或聊天记录。</p>
            </template>
            <p v-else>使用所选服务商的服务地址与密钥；纠错不读取对话模型、角色指令或聊天记录。</p>
            <label>转写模型<input v-model="config.transcription.model" required maxlength="256" autocapitalize="off" :spellcheck="false" autocomplete="off" placeholder="whisper-large-v3" data-testid="voice-model" /></label>
            <details><summary>高级设置</summary>
              <label>语言代码（留空自动检测）<input v-model="config.transcription.language" maxlength="16" /></label>
              <label>转写提示词<textarea v-model="config.transcription.prompt" maxlength="4000" rows="3" /></label>
              <label>转写超时（毫秒）<input v-model.number="config.transcription.timeoutMs" type="number" min="1000" max="180000" step="1000" required /></label>
              <label>总处理超时（毫秒，含纠错）<input v-model.number="config.totalTimeoutMs" type="number" min="1000" max="180000" step="1000" required /></label>
            </details>
          </template>
        </fieldset>
        <div class="voiceActions"><button type="submit" :disabled="busy" :data-testid="isCorrection ? 'correction-save' : 'voice-save'">{{ busy ? '正在保存…' : `保存${title}` }}</button><span v-if="dirty">有未保存的修改</span></div>
      </form>
      <fieldset v-if="!isCorrection"><legend>转写测试</legend>
        <p>仅使用已保存的设置，不保存当前修改；所选音频会发送到转写服务，若已启用纠错，文本还会发送到纠错服务，可能产生费用。</p>
        <label>音频文件（不超过 25 MiB）<input type="file" accept="audio/*,video/mp4" @change="selectSample" data-testid="voice-sample" /></label>
        <button type="button" :disabled="testing || busy || !sample || !saved?.configured || !saved.config.enabled" @click="testTranscription" data-testid="voice-test">测试已保存的配置</button>
        <button v-if="testing" type="button" @click="cancelTest">取消测试</button>
        <div v-if="result" role="status">
          <p>转写：已完成</p><p>纠错：{{ result.correction.status === 'completed' ? '已完成' : result.correction.status === 'disabled' ? '未启用' : '失败，已保留原文' }}</p>
          <p v-if="result.correction.warning">{{ result.correction.warning }}</p><p class="transcript">{{ result.text }}</p>
          <p>转写 {{ result.timings.transcriptionMs }} 毫秒 · 纠错 {{ result.timings.correctionMs }} 毫秒 · 总计 {{ result.timings.totalMs }} 毫秒</p>
        </div>
      </fieldset>
    </template>
  </section>
</template>
<style scoped>
.voiceSettings { min-width: 0; overflow-y: auto; padding: 12px; padding-bottom: max(24px, env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
form, fieldset { min-width: 0; }
fieldset { display: grid; gap: 12px; margin: 12px 0; border: 1px solid var(--border, #777); border-radius: 8px; padding: 12px; }
/* The settings form's legend repeats the active sub-tab label; keep it in the
   accessibility tree but off-screen. The standalone test fieldset legend stays visible. */
form fieldset legend {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
label { display: grid; gap: 6px; min-width: 0; }
input, select, textarea { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; padding: 10px; font: inherit; font-size: 16px; color: inherit; background: var(--bg, transparent); border: 1px solid var(--border, #777); border-radius: 6px; scroll-margin-block: 80px; }
.check { display: flex; align-items: center; }
.check input { width: auto; }
button { padding: 10px 12px; min-height: 44px; cursor: pointer; }
.voiceActions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.transcript { white-space: pre-wrap; }
p { margin: 4px 0; }
</style>
