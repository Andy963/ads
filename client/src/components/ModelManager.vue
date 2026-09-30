<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { ApiClient } from "../api/client";
import type { ModelConfig, ModelProvider } from "../api/types";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_TOKEN_LIMIT,
  MIN_MODEL_CONTEXT_WINDOW,
  MODEL_CONTEXT_KEYS,
  MODEL_OUTPUT_KEYS,
  defaultModelOutputTokens,
  normalizeModelTokenLimit,
  readModelTokenLimit,
} from "../../../shared/modelTokenBudget";
import ModelServicePicker from "./ModelServicePicker.vue";
import RoleSettings from "./RoleSettings.vue";
import VoiceSettings from "./VoiceSettings.vue";
import SettingsSheet from "./SettingsSheet.vue";
import "./modelSettings.css";

type SettingsTab = "roles" | "models" | "lane-prompts";
const props = withDefaults(defineProps<{ api: ApiClient; agent?: string | null; showHeader?: boolean; showTabs?: boolean; initialTab?: SettingsTab }>(), { showHeader: true, showTabs: true, initialTab: "models" });
const emit = defineEmits<{ (e: "close"): void; (e: "changed"): void }>();
const activeTab = ref<SettingsTab>(props.initialTab);
const section = ref("providers");
const sections = [
  { id: "providers", label: "Providers", title: "Providers", icon: "M4 7h16M4 17h16M7 4v6m10 4v6" },
  { id: "conversation", label: "Chat", title: "Conversation", icon: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5A8.5 8.5 0 0 1 11.5 3h1a8.5 8.5 0 0 1 8.5 8.5Z" },
  { id: "transcription", label: "Speech", title: "Transcription", icon: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" },
  { id: "correction", label: "Correction", title: "Correction", icon: "m4 13 5 5L20 6M4 5h6M4 9h3" },
];
const sectionTitle = computed(() => sections.find(tab => tab.id === section.value)?.title);
const providers = ref<ModelProvider[]>([]);
const models = ref<ModelConfig[]>([]);
const busy = ref(false);
const error = ref("");
const notice = ref("");
watch(section, () => { error.value = ""; notice.value = ""; });
const providerDialog = ref(false);
const modelDialog = ref(false);
const providerBaseline = ref("");
const modelBaseline = ref("");
const providerEditor = ref<HTMLFormElement | null>(null);
const modelEditor = ref<HTMLFormElement | null>(null);
const providerActions = ref<ModelProvider | null>(null);
const deleteTarget = ref<{ kind: "provider" | "model"; id: string; name: string } | null>(null);
const providerForm = reactive({ id: "", name: "", baseUrl: "", apiKey: "", hasCredential: false, wireApi: "responses", isEnabled: true });
const modelForm = reactive({ id: "", providerId: "", modelId: "", displayName: "", config: "{}", maxInputTokens: "", maxOutputTokens: "" });
const parsedModelConfig = computed<Record<string, unknown> | null>(() => {
  try {
    const config: unknown = JSON.parse(modelForm.config);
    return config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : null;
  } catch { return null; }
});
const configuredContextWindow = computed(() => readModelTokenLimit(parsedModelConfig.value, MODEL_CONTEXT_KEYS, MIN_MODEL_CONTEXT_WINDOW));
const fallbackOutputTokens = computed(() => defaultModelOutputTokens(configuredContextWindow.value ?? DEFAULT_MODEL_CONTEXT_WINDOW));
const configuredOutputTokens = computed(() => readModelTokenLimit(parsedModelConfig.value, MODEL_OUTPUT_KEYS));
const tokenFields = {
  maxInputTokens: { keys: MODEL_CONTEXT_KEYS, minimum: MIN_MODEL_CONTEXT_WINDOW },
  maxOutputTokens: { keys: MODEL_OUTPUT_KEYS, minimum: 1 },
} as const;
function tokenFieldError(field: keyof typeof tokenFields): string {
  const { keys, minimum } = tokenFields[field];
  return modelForm[field].trim() && normalizeModelTokenLimit(modelForm[field], minimum) === undefined
    ? `${keys[0]} must be an integer between ${minimum} and ${MAX_MODEL_TOKEN_LIMIT}.`
    : "";
}
function syncTokenFields(): void {
  const config = parsedModelConfig.value;
  if (!config) return;
  modelForm.maxInputTokens = String(readModelTokenLimit(config, MODEL_CONTEXT_KEYS, MIN_MODEL_CONTEXT_WINDOW) ?? "");
  modelForm.maxOutputTokens = String(readModelTokenLimit(config, MODEL_OUTPUT_KEYS) ?? "");
}
function updateModelConfig(value: string): void {
  modelForm.config = value;
  syncTokenFields();
}
function updateTokenField(field: keyof typeof tokenFields, value: string): void {
  modelForm[field] = value;
  const config = parsedModelConfig.value;
  const { keys, minimum } = tokenFields[field];
  if (!config || tokenFieldError(field)) return;
  const nextConfig = { ...config };
  // Only an explicit field edit rewrites token keys; untouched legacy JSON stays intact.
  for (const key of keys) delete nextConfig[key];
  if (value.trim()) nextConfig[keys[0]] = normalizeModelTokenLimit(value, minimum);
  modelForm.config = JSON.stringify(nextConfig, null, 2);
}
const groups = computed(() => [
  ...providers.value.map((provider) => ({ id: provider.id, provider, models: models.value.filter((model) => model.providerId === provider.id) })),
  ...(models.value.some((model) => !model.providerId) ? [{ id: "unassigned", provider: null, models: models.value.filter((model) => !model.providerId) }] : []),
]);
async function load(): Promise<void> {
  [providers.value, models.value] = await Promise.all([props.api.get<ModelProvider[]>("/api/model-providers"), props.api.get<ModelConfig[]>("/api/model-configs")]);
}
async function perform(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try { await work(); } catch (err) { error.value = err instanceof Error ? err.message : "Operation failed."; }
  finally { busy.value = false; }
}
function editProvider(provider?: ModelProvider): void {
  Object.assign(providerForm, { id: provider?.id ?? "", name: provider?.name ?? "", baseUrl: provider?.baseUrl ?? "", apiKey: "", hasCredential: provider?.hasCredential ?? false, wireApi: provider?.wireApi || "responses", isEnabled: provider?.isEnabled ?? true });
  error.value = "";
  providerBaseline.value = JSON.stringify(providerForm);
  providerDialog.value = true;
}
function closeProvider(): void { providerDialog.value = false; providerForm.apiKey = ""; }
async function saveProvider(): Promise<void> {
  if (providerEditor.value && !providerEditor.value.reportValidity()) return;
  await perform(async () => {
    const payload = { name: providerForm.name.trim(), baseUrl: providerForm.baseUrl.trim(), wireApi: providerForm.wireApi, isEnabled: providerForm.isEnabled, ...(providerForm.apiKey.trim() ? { apiKey: providerForm.apiKey.trim() } : {}) };
    if (providerForm.id) await props.api.patch(`/api/model-providers/${encodeURIComponent(providerForm.id)}`, payload);
    else await props.api.post("/api/model-providers", payload);
    closeProvider();
    await load();
    emit("changed");
  });
}
async function syncProvider(provider: ModelProvider): Promise<void> {
  providerActions.value = null;
  await perform(async () => {
    await props.api.post(`/api/model-providers/${encodeURIComponent(provider.id)}/models/sync`, {});
    await load();
    notice.value = "Models synchronized. Existing aliases and effort settings were preserved.";
  });
}
async function deleteProvider(provider: ModelProvider): Promise<void> {
  providerActions.value = null;
  error.value = "";
  deleteTarget.value = { kind: "provider", id: provider.id, name: provider.name };
}
function editModel(providerId: string, model?: ModelConfig): void {
  Object.assign(modelForm, { id: model?.id ?? "", providerId, modelId: model?.modelId ?? "", displayName: model?.displayName ?? "", config: JSON.stringify(model?.configJson ?? { reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high" }, null, 2) });
  syncTokenFields();
  modelDialog.value = true;
  modelBaseline.value = JSON.stringify(modelForm);
  error.value = "";
}
async function saveModel(): Promise<void> {
  const tokenError = tokenFieldError("maxInputTokens") || tokenFieldError("maxOutputTokens");
  if (tokenError) { error.value = tokenError; return; }
  if (modelEditor.value && !modelEditor.value.reportValidity()) return;
  await perform(async () => {
    const configJson: unknown = JSON.parse(modelForm.config);
    if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) throw new Error("Model configuration must be a JSON object.");
    const provider = providers.value.find((item) => item.id === modelForm.providerId);
    if (!provider) throw new Error("Select a provider.");
    const payload = { modelId: modelForm.modelId.trim(), displayName: modelForm.displayName.trim() || modelForm.modelId.trim(), provider: provider.name, providerId: provider.id, configJson, isEnabled: true };
    if (modelForm.id) await props.api.patch(`/api/model-configs/${encodeURIComponent(modelForm.id)}`, payload);
    else await props.api.post("/api/model-configs", payload);
    modelDialog.value = false;
    await load();
    emit("changed");
  });
}
async function deleteModel(model: ModelConfig): Promise<void> {
  error.value = "";
  deleteTarget.value = { kind: "model", id: model.id, name: model.displayName };
}
async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  await perform(async () => {
    await props.api.delete(`/api/${target.kind === 'provider' ? 'model-providers' : 'model-configs'}/${encodeURIComponent(target.id)}${target.kind === 'model' ? '?removeReferences=true' : ''}`);
    deleteTarget.value = null;
    closeProvider();
    modelDialog.value = false;
    await load();
    emit("changed");
  });
}
onMounted(() => perform(load));
onBeforeUnmount(() => { providerForm.apiKey = ""; });
</script>

<template>
  <section class="iosSettings modelManager" :class="{ 'modelManager--roles': activeTab !== 'models' }" data-testid="model-manager">
    <header v-if="showHeader" class="managerHeader">
      <h2>Settings</h2><button type="button" class="settingsIconButton" aria-label="Close settings" @click="emit('close')">✕</button>
    </header>
    <nav v-if="showTabs" class="settingsTabs">
      <button type="button" :class="{ active: activeTab !== 'models' }" data-testid="settings-tab-prompts" @click="activeTab = 'roles'">Role instructions</button>
      <button type="button" :class="{ active: activeTab === 'models' }" data-testid="settings-tab-models" @click="activeTab = 'models'">Models</button>
    </nav>
    <template v-if="activeTab === 'models'">
      <nav class="settingsDestinations" aria-label="Model services">
        <button v-for="tab in sections" :key="tab.id" type="button" :class="{ active: section === tab.id }" :aria-pressed="section === tab.id"
          :data-testid="(tab.id === 'transcription' ? 'voice' : tab.id === 'providers' ? 'provider' : tab.id) + '-settings-tab'" @click="section = tab.id">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="tab.icon" /></svg>
          <span>{{ tab.label }}</span>
        </button>
      </nav>
      <div class="settingsBody">
        <header class="destinationHeader">
          <h1>{{ sectionTitle }}</h1>
          <button v-if="section === 'providers'" type="button" class="settingsIconButton" aria-label="Add provider" data-testid="provider-add" :disabled="busy" @click="editProvider()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </header>
        <p v-if="error && !providerDialog && !modelDialog && !deleteTarget" class="settingsFeedback" role="alert">{{ error }}</p>
        <p v-if="notice" class="settingsFeedback" role="status">{{ notice }}</p>
        <div v-if="section === 'providers'" data-testid="settings-providers-panel">
          <p class="settingsNote introduction">Your connections and model library. Tap a provider or model to edit.</p>
          <div v-if="!groups.length" class="emptyProviders">
            <h2>Add your first provider</h2><p>Connect a service, then sync its models.</p>
            <button type="button" class="settingsPrimary" :disabled="busy" @click="editProvider()">Add provider</button>
          </div>
          <article v-for="group in groups" :key="group.id" class="settingsBlock" :data-testid="'provider-row-' + group.id">
            <div class="providerHeading">
              <h2 class="settingsBlockTitle">{{ group.provider?.name || 'Unassigned models' }}</h2>
              <button v-if="group.provider" type="button" class="settingsIconButton" :aria-label="'Actions for ' + group.provider.name" :data-testid="'provider-actions-' + group.id" :disabled="busy" @click="providerActions = group.provider">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
              </button>
            </div>
            <div class="settingsList">
              <button v-if="group.provider" type="button" class="settingsRow" :disabled="busy" :data-testid="'provider-edit-' + group.id" @click="editProvider(group.provider)">
                <span class="providerSymbol" aria-hidden="true">{{ group.provider.name.slice(0, 1).toUpperCase() }}</span>
                <span class="settingsRowContent"><span>Connection</span><small class="settingsDetail">{{ group.provider.baseUrl }}</small></span>
                <span class="connectionStatus" :class="{ ready: group.provider.isEnabled && group.provider.hasCredential }">{{ !group.provider.isEnabled ? 'Off' : group.provider.hasCredential ? 'Ready' : 'Set up' }}</span>
                <span class="settingsChevron" aria-hidden="true">›</span>
              </button>
              <button v-for="model in group.models" :key="model.id" type="button" class="settingsRow modelRow" :disabled="busy" :data-testid="'model-row-' + model.id" @click="editModel(model.providerId || '', model)">
                <span class="settingsRowContent"><span>{{ model.displayName }}</span><small class="settingsDetail">{{ model.modelId }}</small></span>
                <span class="settingsChevron" aria-hidden="true">›</span>
              </button>
              <button v-if="group.provider" type="button" class="settingsRow tinted" :disabled="busy" :data-testid="'provider-add-model-' + group.id" @click="editModel(group.id)"><span aria-hidden="true">＋</span>Add model</button>
            </div>
            <p v-if="!group.provider" class="settingsNote">Choose a provider when editing these legacy models.</p>
          </article>
        </div>
        <ModelServicePicker v-else-if="section === 'conversation'" :api="api" service="conversation" @changed="emit('changed')" />
        <VoiceSettings v-else :key="section" :api="api" :section="section === 'correction' ? 'correction' : 'transcription'" @changed="emit('changed')" />
      </div>
    </template>
    <RoleSettings v-else :api="api" @changed="emit('changed')" />

    <SettingsSheet v-if="providerDialog" :title="providerForm.id ? 'Edit provider' : 'Add provider'" :busy="busy" :dirty="JSON.stringify(providerForm) !== providerBaseline"
      action-label="Done" test-id="provider-dialog" action-test-id="provider-save" @close="closeProvider" @submit="saveProvider">
      <form ref="providerEditor" data-testid="provider-form" @submit.prevent="saveProvider">
        <p v-if="error && !deleteTarget" class="settingsFeedback" role="alert">{{ error }}</p>
        <fieldset :disabled="busy">
          <div class="settingsBlock"><h3 class="settingsBlockTitle">Connection</h3><div class="settingsList">
            <label class="settingsField"><span>Name</span><input v-model="providerForm.name" required data-testid="provider-name" placeholder="Provider name" /></label>
            <label class="settingsField"><span>Base URL</span><input v-model="providerForm.baseUrl" type="url" inputmode="url" required autocomplete="off" autocapitalize="none" spellcheck="false" data-testid="provider-base-url" placeholder="https://api.example.com/v1" /></label>
            <label class="settingsField"><span>API key</span><input v-model="providerForm.apiKey" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" data-testid="provider-api-key" :placeholder="providerForm.hasCredential ? 'Leave blank to keep saved key' : 'Enter API key'" /></label>
          </div><p class="settingsNote">Keys are encrypted on the server. A new address requires a matching key.</p></div>
          <div class="settingsBlock"><div class="settingsList">
            <label class="settingsField"><span>API format</span><select v-model="providerForm.wireApi" data-testid="provider-wire-api"><option value="responses">Responses</option><option value="chat">Chat completions</option></select></label>
            <p class="settingsNote">Native runtime supports Chat completions only.</p>
            <label class="settingsRow"><span class="settingsRowContent">Enabled</span><input v-model="providerForm.isEnabled" class="settingsSwitch" type="checkbox" role="switch" data-testid="provider-enabled" /></label>
          </div></div>
          <div v-if="providerForm.id" class="settingsBlock settingsList"><button type="button" class="settingsRow destructive centered" @click="deleteProvider(providers.find(p => p.id === providerForm.id)!)">Delete provider</button></div>
        </fieldset>
      </form>
    </SettingsSheet>

    <SettingsSheet v-if="modelDialog" :title="modelForm.id ? 'Edit model' : 'Add model'" :busy="busy" :dirty="JSON.stringify(modelForm) !== modelBaseline"
      action-label="Done" test-id="model-manager-dialog" action-test-id="model-manager-save" @close="modelDialog = false" @submit="saveModel">
      <form ref="modelEditor" data-testid="model-form" @submit.prevent="saveModel">
        <p v-if="error && !deleteTarget" class="settingsFeedback" role="alert">{{ error }}</p>
        <fieldset :disabled="busy">
          <div class="settingsBlock settingsList">
            <label class="settingsField"><span>Provider</span><select v-model="modelForm.providerId" required data-testid="model-manager-provider"><option value="" disabled>Choose a provider</option><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select></label>
            <label class="settingsField"><span>Model ID</span><input v-model="modelForm.modelId" required autocapitalize="none" spellcheck="false" data-testid="model-manager-model-id" placeholder="Upstream model identifier" /></label>
            <label class="settingsField"><span>Display name</span><input v-model="modelForm.displayName" data-testid="model-manager-display-name" placeholder="Optional alias" /></label>
          </div>
          <div class="settingsBlock"><h3 class="settingsBlockTitle">Token limits</h3><div class="settingsList">
            <label class="settingsField"><span>Context window (max_input_tokens)</span><input :value="modelForm.maxInputTokens" type="text" inputmode="numeric" :disabled="!parsedModelConfig" :aria-invalid="!!tokenFieldError('maxInputTokens')" aria-describedby="model-token-defaults" data-testid="model-manager-max-input-tokens" :placeholder="String(DEFAULT_MODEL_CONTEXT_WINDOW)" @input="updateTokenField('maxInputTokens', ($event.target as HTMLInputElement).value)" /></label>
            <label class="settingsField"><span>Output limit (max_output_tokens)</span><input :value="modelForm.maxOutputTokens" type="text" inputmode="numeric" :disabled="!parsedModelConfig" :aria-invalid="!!tokenFieldError('maxOutputTokens')" aria-describedby="model-token-defaults" data-testid="model-manager-max-output-tokens" :placeholder="String(fallbackOutputTokens)" @input="updateTokenField('maxOutputTokens', ($event.target as HTMLInputElement).value)" /></label>
          </div><p id="model-token-defaults" class="settingsNote" data-testid="model-manager-token-defaults">Default context: {{ DEFAULT_MODEL_CONTEXT_WINDOW }}; default output: {{ fallbackOutputTokens }} (at most half the context window). Defaults may be overridden by server configuration. Leave blank to use server fallbacks; clearing a field also removes its legacy aliases.</p>
          <p class="settingsNote" data-testid="model-manager-token-configured">Configured limits: context {{ configuredContextWindow ?? 'not set' }}; output {{ configuredOutputTokens ?? 'not set' }}. Runtime may cap output to fit the context window.</p>
          <p v-if="!parsedModelConfig" class="settingsNote">Enter a valid JSON object in Advanced options to edit token limits.</p></div>
          <details class="settingsBlock modelAdvanced"><summary>Advanced options</summary><div class="settingsList">
            <label class="settingsField"><span>Model configuration (JSON)</span><textarea :value="modelForm.config" rows="7" autocapitalize="none" spellcheck="false" data-testid="model-manager-config-json" @input="updateModelConfig(($event.target as HTMLTextAreaElement).value)" /></label>
          </div><p class="settingsNote">Includes effort tiers and provider-specific options. Existing values are preserved.</p></details>
          <div v-if="modelForm.id" class="settingsBlock settingsList"><button type="button" class="settingsRow destructive centered" @click="deleteModel(models.find(m => m.id === modelForm.id)!)">Delete model</button></div>
        </fieldset>
      </form>
    </SettingsSheet>

    <SettingsSheet v-if="providerActions" :title="providerActions.name" test-id="provider-actions" @close="providerActions = null">
      <div class="settingsBlock settingsList">
        <button type="button" class="settingsRow tinted" :disabled="!providerActions.isEnabled" :data-testid="'provider-sync-' + providerActions.id" @click="syncProvider(providerActions)">Sync models</button>
        <button type="button" class="settingsRow destructive" :data-testid="'provider-delete-' + providerActions.id" @click="deleteProvider(providerActions)">Delete provider</button>
      </div>
    </SettingsSheet>
    <SettingsSheet v-if="deleteTarget" title="Delete?" action-label="Delete" destructive :busy="busy" test-id="settings-delete-confirm" @close="deleteTarget = null; error = ''" @submit="confirmDelete">
      <div class="settingsBlock"><p>Delete {{ deleteTarget.name }}?</p><p class="settingsNote">{{ deleteTarget.kind === 'model' ? 'This also removes it from enabled services. If it is a default, another enabled model becomes the default; an empty service has none. Roles using it follow the remaining conversation default. This cannot be undone.' : 'Remove this provider from all enabled services first. Its models are kept as unassigned. This cannot be undone.' }}</p><p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p></div>
    </SettingsSheet>
  </section>
</template>

<style scoped>
.modelManager { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--settings-background); }
.managerHeader { display: flex; align-items: center; justify-content: space-between; padding: 4px 16px; background: var(--settings-surface); }
.managerHeader h2 { margin: 0; font-size: 17px; font-weight: 600; }
.settingsTabs { display: flex; gap: 2px; flex: 0 0 auto; margin: 12px 16px; padding: 3px; border-radius: 9px; background: var(--segmented-bg); }
.settingsTabs button { flex: 1; min-height: 36px; border: 0; background: none; color: inherit; font-size: 14px; border-radius: 7px; }
.settingsTabs .active { background: white; box-shadow: 0 1px 3px #0002; }
.settingsDestinations { display: flex; flex: 0 0 auto; padding: 4px 16px; gap: 6px; background: var(--settings-surface); }
.settingsDestinations button { display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; min-width: 0; min-height: 48px; padding: 4px; border: 0; border-radius: 8px; background: none; font-size: 14px; color: var(--settings-secondary); }
.settingsDestinations button.active { color: var(--settings-tint); background: #007aff0b; }
.settingsDestinations svg { width: 22px; height: 22px; flex: 0 0 auto; }
.settingsBody { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 24px 28px; }
.destinationHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.destinationHeader h1 { margin: 0; font-size: 30px; line-height: 1.2; letter-spacing: -.03em; font-weight: 700; }
.introduction { margin: 10px 0 0; }
.providerHeading { display: flex; align-items: center; justify-content: space-between; padding-left: 16px; }
.providerHeading .settingsBlockTitle { margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.providerSymbol { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; border-radius: 8px; background: #e8f1ff; color: var(--settings-tint); font-size: 17px; font-weight: 600; }
.connectionStatus { font-size: 12px; color: var(--settings-secondary); }
.connectionStatus.ready { color: #248a3d; }
.emptyProviders { padding: 48px 16px; text-align: center; }
.emptyProviders h2 { font-size: 22px; }
.emptyProviders p { color: var(--settings-secondary); margin-bottom: 24px; }
.modelAdvanced summary { min-height: 44px; padding: 12px 16px; color: var(--settings-tint); font-size: 15px; cursor: pointer; }
@media (max-width: 900px) {
  .settingsBody { padding: 8px 12px 12px; }
  .settingsBody :deep(.settingsBlock) { margin: 12px 0; }
  .settingsBody :deep(.settingsRow) { min-height: 48px; padding: 10px 12px; }
  .introduction { margin-top: 4px; }
  .emptyProviders { padding: 28px 12px; }
  .settingsDestinations { order: 2; gap: 0; padding: 4px 4px max(5px, env(safe-area-inset-bottom, 0px)); border-top: .5px solid var(--settings-separator); background: #f9f9fbed; }
  .settingsDestinations button { flex-direction: column; gap: 3px; min-height: 50px; font-size: 10px; border-radius: 0; }
  .settingsDestinations button.active { background: none; }
  .settingsDestinations svg { width: 24px; height: 24px; }
  .destinationHeader h1 { font-size: 22px; letter-spacing: -.02em; }
}
</style>
