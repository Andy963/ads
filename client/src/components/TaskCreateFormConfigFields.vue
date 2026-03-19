<script setup lang="ts">
const props = defineProps<{
  title: string;
  reviewRequired: boolean;
  bootstrapEnabled: boolean;
  bootstrapProject: string;
  bootstrapMaxIterations: number;
}>();

const emit = defineEmits<{
  (e: "update:title", value: string): void;
  (e: "update:reviewRequired", value: boolean): void;
  (e: "update:bootstrapEnabled", value: boolean): void;
  (e: "update:bootstrapProject", value: string): void;
  (e: "update:bootstrapMaxIterations", value: number): void;
}>();
</script>

<template>
  <label class="field">
    <span class="label">标题（可选）</span>
    <input :value="title" placeholder="不填会自动生成" @input="emit('update:title', ($event.target as HTMLInputElement).value)" />
  </label>
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

input {
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

input:hover {
  border-color: rgba(148, 163, 184, 0.8);
  background: rgba(255, 255, 255, 0.95);
}

input:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

input::placeholder {
  color: #94a3b8;
}
</style>
