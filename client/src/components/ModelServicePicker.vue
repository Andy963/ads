<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ApiClient } from "../api/client";
import type { ModelConfig, ModelProvider } from "../api/types";
import type { ModelService, ModelServiceSelection } from "../../../shared/modelServices";
import SettingsSheet from "./SettingsSheet.vue";

const props = defineProps<{ api: ApiClient; service: ModelService }>();
const emit = defineEmits<{ (e: "changed"): void }>();
const models = ref<ModelConfig[]>([]);
const providers = ref<ModelProvider[]>([]);
const selected = ref<string[]>([]);
const defaultId = ref<string | null>(null);
const busy = ref(false);
const error = ref("");
const choosingDefault = ref(false);
const available = computed(() => models.value.filter((model) => model.isEnabled && (!model.providerId
  ? props.service === "conversation" : providers.value.some((provider) => provider.id === model.providerId && provider.isEnabled))));
const enabledModels = computed(() => available.value.filter(model => selected.value.includes(model.id)));
const defaultModel = computed(() => models.value.find(model => model.id === defaultId.value));
const unavailable = computed(() => selected.value.filter(id => !available.value.some(model => model.id === id)));
const providerName = (model: ModelConfig) => providers.value.find(provider => provider.id === model.providerId)?.name || model.provider;

async function load(): Promise<void> {
  busy.value = true;
  try {
    const [catalog, sources, services] = await Promise.all([
      props.api.get<ModelConfig[]>("/api/model-configs"), props.api.get<ModelProvider[]>("/api/model-providers"),
      props.api.get<ModelServiceSelection[]>("/api/model-services"),
    ]);
    models.value = catalog;
    providers.value = sources;
    const selection = services.find(item => item.service === props.service);
    selected.value = selection?.modelIds ?? [];
    defaultId.value = selection?.defaultModelId ?? null;
  } catch (err) { error.value = err instanceof Error ? err.message : "Could not load models."; }
  finally { busy.value = false; }
}
async function save(modelIds: string[], nextDefault: string | null): Promise<boolean> {
  if (busy.value) return false;
  const previous = { modelIds: selected.value, defaultId: defaultId.value };
  busy.value = true;
  error.value = "";
  selected.value = modelIds;
  defaultId.value = nextDefault;
  try {
    await props.api.put("/api/model-services/" + props.service, { modelIds, defaultModelId: nextDefault });
    emit("changed");
    return true;
  } catch (err) {
    selected.value = previous.modelIds;
    defaultId.value = previous.defaultId;
    error.value = err instanceof Error ? err.message : "Could not save. Your previous selection was restored.";
    return false;
  } finally { busy.value = false; }
}
async function toggle(id: string, checked: boolean): Promise<void> {
  const next = checked ? [...new Set([...selected.value, id])] : selected.value.filter(value => value !== id);
  await save(next, defaultId.value && next.includes(defaultId.value) ? defaultId.value : next[0] ?? null);
}
async function chooseDefault(id: string): Promise<void> {
  if (await save([...selected.value], id)) choosingDefault.value = false;
}
async function removeUnavailable(): Promise<void> {
  const next = selected.value.filter(id => available.value.some(model => model.id === id));
  await save(next, defaultId.value && next.includes(defaultId.value) ? defaultId.value : next[0] ?? null);
}
onMounted(load);
</script>

<template>
  <section class="servicePicker" :data-testid="'service-models-' + service" :aria-busy="busy">
    <div class="settingsBlock">
      <div class="settingsList">
        <button type="button" class="settingsRow" data-testid="service-default-open" :disabled="busy || !enabledModels.length" @click="choosingDefault = true">
          <span class="settingsRowContent"><span>Default model</span><small class="settingsDetail">{{ defaultModel?.displayName || 'Enable a model below' }}</small></span><span class="settingsChevron" aria-hidden="true">›</span>
        </button>
      </div>
      <p class="settingsNote">{{ service === 'conversation' ? 'Choose among enabled models in chat and role settings.' : 'Each request uses this model only. Other enabled models remain available to choose as the default.' }}</p>
    </div>
    <p v-if="error && !choosingDefault" role="alert" class="settingsFeedback">{{ error }}</p>
    <div class="settingsBlock">
      <h2 class="settingsBlockTitle">Enabled models</h2>
      <fieldset :disabled="busy"><div class="settingsList">
        <label v-for="model in available" :key="model.id" class="settingsRow">
          <span class="settingsRowContent"><span>{{ model.displayName || model.modelId }}</span><small class="settingsDetail">{{ providerName(model) }}{{ model.id === defaultId ? ' · Default' : '' }}</small></span>
          <input class="settingsSwitch" type="checkbox" role="switch" :checked="selected.includes(model.id)" :data-testid="'service-enable-' + model.id" @change="toggle(model.id, ($event.target as HTMLInputElement).checked)" />
        </label>
        <div v-for="id in unavailable" :key="id" class="settingsRow">
          <span class="settingsRowContent">{{ models.find(model => model.id === id)?.displayName || 'Unavailable model' }}<small class="settingsDetail">No longer available</small></span>
        </div>
        <button v-if="unavailable.length" type="button" class="settingsRow destructive" data-testid="service-remove-unavailable" @click="removeUnavailable">Remove unavailable models</button>
      </div></fieldset>
      <p v-if="!available.length" class="settingsNote">Add models in Providers first.</p>
      <p v-else class="settingsNote" role="status">{{ busy ? 'Saving…' : 'Changes save automatically.' }}</p>
    </div>
    <SettingsSheet v-if="choosingDefault" title="Default model" :busy="busy" test-id="service-default-picker" @close="choosingDefault = false">
      <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
      <div class="settingsBlock settingsList">
        <label v-for="model in enabledModels" :key="model.id" class="settingsRow">
          <input class="settingsRadio" type="radio" :name="'default-' + service" :checked="defaultId === model.id" :disabled="busy" :data-testid="'service-default-' + model.id" @change="chooseDefault(model.id)" />
          <span class="settingsRowContent"><span>{{ model.displayName || model.modelId }}</span><small class="settingsDetail">{{ providerName(model) }}</small></span>
          <span class="settingsCheckmark" aria-hidden="true">{{ defaultId === model.id ? '✓' : '' }}</span>
        </label>
      </div>
    </SettingsSheet>
  </section>
</template>
