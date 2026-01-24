<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const local = ref(props.modelValue);
watch(
  () => props.modelValue,
  (next) => {
    local.value = next;
  },
);

const disabled = computed(() => !local.value.trim());

function submit(): void {
  emit("update:modelValue", local.value.trim());
}
</script>

<template>
  <div class="gate">
    <div class="card">
      <div class="logo">
        <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h2 class="title">ADS Tasks</h2>
      <p class="desc">请输入 <code>ADS_WEB_TOKEN</code>（兼容 <code>WEB_AUTH_TOKEN</code>）以访问 API/WS。</p>
      <div class="form">
        <input v-model="local" type="password" placeholder="输入您的 Token" @keydown.enter.prevent="submit" />
        <button class="submit-btn" :disabled="disabled" @click="submit">连接</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: linear-gradient(135deg, #0b1020 0%, #1e293b 100%);
  color: #e5e7eb;
}
.card {
  width: min(440px, 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 32px;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(12px);
  text-align: center;
}
.logo {
  width: 64px;
  height: 64px;
  margin: 0 auto 24px;
  background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
  border-radius: 16px;
  display: grid;
  place-items: center;
  box-shadow: 0 8px 24px rgba(37, 99, 235, 0.3);
}
.logo-icon {
  width: 32px;
  height: 32px;
  color: white;
}
.title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: white;
}
.desc {
  color: rgba(229, 231, 235, 0.7);
  margin: 0 0 24px 0;
  font-size: 14px;
  line-height: 1.6;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
input {
  width: 100%;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.3);
  color: #e5e7eb;
  font-size: 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
input::placeholder {
  color: rgba(229, 231, 235, 0.4);
}
input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
}
.submit-btn {
  width: 100%;
  padding: 14px 16px;
  border-radius: 10px;
  border: none;
  background: #2563eb;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s, transform 0.1s;
}
.submit-btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.submit-btn:active:not(:disabled) {
  transform: scale(0.98);
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
code {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 13px;
}
</style>
