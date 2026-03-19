<script setup lang="ts">
type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const props = defineProps<{
  title: string;
  agentId: string;
  priority: number;
  maxRetries: number;
  reviewRequired: boolean;
  bootstrapEnabled: boolean;
  bootstrapProject: string;
  bootstrapMaxIterations: number;
  readyAgentOptions: AgentOption[];
}>();

const emit = defineEmits<{
  (e: "update:title", value: string): void;
  (e: "update:agentId", value: string): void;
  (e: "update:priority", value: number): void;
  (e: "update:maxRetries", value: number): void;
  (e: "update:reviewRequired", value: boolean): void;
  (e: "update:bootstrapEnabled", value: boolean): void;
  (e: "update:bootstrapProject", value: string): void;
  (e: "update:bootstrapMaxIterations", value: number): void;
}>();

function formatAgentLabel(agent: AgentOption): string {
  const id = String(agent.id ?? "").trim();
  const name = String(agent.name ?? "").trim() || id;
  if (!id) return name || "agent";
  const base = name === id ? id : `${name} (${id})`;
  if (agent.ready) return base;
  const suffix = String(agent.error ?? "").trim() || "不可用";
  return `${base}（不可用：${suffix}）`;
}
</script>

<template>
  <label class="field">
    <span class="label">标题（可选）</span>
    <input :value="title" placeholder="不填会自动生成" @input="emit('update:title', ($event.target as HTMLInputElement).value)" />
  </label>

  <div class="configRow">
    <label class="field">
      <span class="label">执行器</span>
      <select :value="agentId" data-testid="task-create-agent" @change="emit('update:agentId', ($event.target as HTMLSelectElement).value)">
        <option value="">自动</option>
        <option v-for="a in readyAgentOptions" :key="a.id" :value="a.id">
          {{ formatAgentLabel(a) }}
        </option>
      </select>
    </label>
    <label class="field">
      <span class="label">优先级</span>
      <input :value="priority" type="number" @input="emit('update:priority', Number(($event.target as HTMLInputElement).value))" />
    </label>
    <label class="field">
      <span class="label">最大重试</span>
      <input :value="maxRetries" type="number" min="0" @input="emit('update:maxRetries', Number(($event.target as HTMLInputElement).value))" />
    </label>
  </div>

  <div class="configRowCheckboxes">
    <label class="field bootstrapToggle">
      <input
        type="checkbox"
        :checked="reviewRequired"
        data-testid="task-create-review-required"
        @change="emit('update:reviewRequired', ($event.target as HTMLInputElement).checked)"
      />
      <span class="checkboxLabel">需要 Reviewer 审核</span>
    </label>
    <label class="field bootstrapToggle">
      <input
        type="checkbox"
        :checked="bootstrapEnabled"
        data-testid="task-create-bootstrap-toggle"
        @change="emit('update:bootstrapEnabled', ($event.target as HTMLInputElement).checked)"
      />
      <span class="checkboxLabel">自举模式</span>
    </label>
  </div>

  <div v-if="bootstrapEnabled" class="configRow">
    <label class="field bootstrapProjectField">
      <span class="label">项目路径 / Git URL</span>
      <input
        :value="bootstrapProject"
        placeholder="/path/to/project 或 https://..."
        data-testid="task-create-bootstrap-project"
        @input="emit('update:bootstrapProject', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <label class="field bootstrapIterationsField">
      <span class="label">最大迭代</span>
      <input
        :value="bootstrapMaxIterations"
        type="number"
        min="1"
        max="10"
        data-testid="task-create-bootstrap-max-iterations"
        @input="emit('update:bootstrapMaxIterations', Number(($event.target as HTMLInputElement).value))"
      />
    </label>
  </div>
</template>

<style scoped>
.field {
  display: block;
  min-width: 0;
}

.label {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 4px;
}

input,
select {
  width: 100%;
  padding: 8px 10px;
  border-radius: 14px;
  border: 1px solid var(--border);
  font-size: 14px;
  background: rgba(248, 250, 252, 0.95);
  color: #1e293b;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

input:hover,
select:hover {
  border-color: rgba(148, 163, 184, 0.8);
  background: rgba(255, 255, 255, 0.95);
}

input:focus,
select:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

input::placeholder {
  color: #94a3b8;
}

.configRow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  align-items: end;
  flex-wrap: nowrap;
}

.configRowCheckboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  align-items: center;
}

.bootstrapToggle {
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
}

.bootstrapToggle input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
  accent-color: #2563eb;
}

.checkboxLabel {
  display: inline;
  margin: 0 0 0 6px;
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
}

.bootstrapProjectField {
  flex: 1;
}

.bootstrapIterationsField {
  width: 100px;
}

@media (max-width: 600px) {
  .configRow {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .bootstrapIterationsField {
    width: auto;
  }
}
</style>
