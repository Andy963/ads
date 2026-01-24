<script setup lang="ts">
import { computed, ref } from "vue";
import type { CreateTaskInput, ModelConfig } from "../api/types";

const props = defineProps<{ models: ModelConfig[] }>();
const emit = defineEmits<{ (e: "submit", v: CreateTaskInput): void }>();

const title = ref("");
const prompt = ref("");
const model = ref("auto");
const priority = ref(0);
const maxRetries = ref(3);

const canSubmit = computed(() => prompt.value.trim().length > 0);

function submit(): void {
  if (!canSubmit.value) return;
  const titleTrimmed = title.value.trim();
  emit("submit", {
    title: titleTrimmed.length ? titleTrimmed : undefined,
    prompt: prompt.value.trim(),
    model: model.value,
    priority: Number.isFinite(priority.value) ? priority.value : 0,
    maxRetries: Number.isFinite(maxRetries.value) ? maxRetries.value : 3,
  });
  title.value = "";
  prompt.value = "";
}

function onPromptKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Enter") return;
  if ((ev as { isComposing?: boolean }).isComposing) return;
  if (ev.altKey) return; // Alt+Enter: newline
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  ev.preventDefault();
  submit();
}

const modelOptions = computed(() => {
  const enabled = props.models.filter((m) => m.isEnabled);
  return [{ id: "auto", displayName: "Auto", provider: "" }, ...enabled];
});
</script>

<template>
  <div class="card">
    <h3 class="form-title">新建任务</h3>
    
    <div class="form-row">
      <label class="form-field">
        <span class="label-text">标题（可选）</span>
        <input v-model="title" placeholder="不填会自动生成" />
      </label>
    </div>
    
    <div class="form-row form-row-3">
      <label class="form-field">
        <span class="label-text">模型</span>
        <select v-model="model">
          <option v-for="m in modelOptions" :key="m.id" :value="m.id">
            {{ m.displayName }}{{ m.provider ? ` (${m.provider})` : "" }}
          </option>
        </select>
      </label>
      <label class="form-field">
        <span class="label-text">优先级</span>
        <input v-model.number="priority" type="number" />
      </label>
      <label class="form-field">
        <span class="label-text">最大重试</span>
        <input v-model.number="maxRetries" type="number" min="0" />
      </label>
    </div>
    
    <div class="form-row">
      <label class="form-field">
        <span class="label-text">Prompt</span>
        <textarea
          v-model="prompt"
          rows="4"
          placeholder="描述要做什么…（Enter 提交，Alt+Enter 换行）"
          @keydown="onPromptKeydown"
        />
      </label>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: none;
  border-radius: 12px;
  padding: 20px;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06);
}
.form-title {
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 700;
  color: #1e293b;
}
.form-row {
  margin-bottom: 16px;
}
.form-row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.form-field {
  display: block;
}
.label-text {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #475569;
  margin-bottom: 6px;
}
input,
select,
textarea {
  display: block;
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  font-size: 14px;
  background: #f8fafc;
  color: #1e293b;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}
input:hover,
select:hover,
textarea:hover {
  border-color: #cbd5e1;
  background: white;
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: #2563eb;
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}
input::placeholder,
textarea::placeholder {
  color: #94a3b8;
}
textarea {
  resize: none;
  min-height: 80px;
  max-height: 200px;
  overflow-y: auto;
}
@media (max-width: 600px) {
  .form-row-3 {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}
</style>
