<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Prompt } from "../api/types";

import "./PromptsModal.css";

const props = defineProps<{
  prompts: Prompt[];
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "create", input: { name: string; content: string }): void;
  (e: "update", id: string, input: { name: string; content: string }): void;
  (e: "delete", id: string): void;
}>();

const selectedId = ref<string | null>(null);
const draftName = ref("");
const draftContent = ref("");

const selectedPrompt = computed(() => {
  const id = String(selectedId.value ?? "").trim();
  if (!id) return null;
  return props.prompts.find((p) => p.id === id) ?? null;
});

const isNew = computed(() => selectedId.value == null);
const canSave = computed(() => Boolean(draftName.value.trim()) && !props.busy);
const canDelete = computed(() => Boolean(selectedId.value) && !props.busy);

watch(
  () => props.prompts,
  (next) => {
    if (selectedId.value && next.some((p) => p.id === selectedId.value)) {
      return;
    }
    selectedId.value = next.length ? next[0]!.id : null;
  },
  { immediate: true },
);

watch(
  () => selectedPrompt.value,
  (p) => {
    if (!p) {
      draftName.value = "";
      draftContent.value = "";
      return;
    }
    draftName.value = p.name;
    draftContent.value = p.content;
  },
  { immediate: true },
);

function onNew(): void {
  selectedId.value = null;
  draftName.value = "";
  draftContent.value = "";
}

function onSelect(id: string): void {
  const pid = String(id ?? "").trim();
  if (!pid) return;
  selectedId.value = pid;
}

function onSave(): void {
  const name = draftName.value.trim();
  const content = draftContent.value;
  if (!name) return;
  if (props.busy) return;
  if (isNew.value) {
    emit("create", { name, content });
    return;
  }
  const id = String(selectedId.value ?? "").trim();
  if (!id) return;
  emit("update", id, { name, content });
}

function onDelete(): void {
  const id = String(selectedId.value ?? "").trim();
  if (!id) return;
  if (props.busy) return;
  emit("delete", id);
}
</script>

<template>
  <div class="modalOverlay" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="modalCard promptsModal">
      <div class="promptsHeader">
        <div class="promptsTitle">Prompts</div>
        <div class="promptsActions">
          <button type="button" class="promptsBtn" :disabled="busy" @click="onNew">New</button>
          <button type="button" class="promptsBtn danger" :disabled="!canDelete" @click="onDelete">Delete</button>
          <button type="button" class="promptsBtn primary" :disabled="!canSave" @click="onSave">Save</button>
          <button type="button" class="promptsBtn" @click="emit('close')">Close</button>
        </div>
      </div>

      <div class="promptsBody">
        <div class="promptsList" aria-label="Prompt list">
          <div class="promptsListHeader">Library</div>
          <div class="promptsListItems">
            <button
              v-for="p in prompts"
              :key="p.id"
              type="button"
              class="promptRow"
              :class="{ active: p.id === selectedId }"
              :title="p.name"
              :disabled="busy"
              @click="onSelect(p.id)"
            >
              {{ p.name }}
            </button>
          </div>
        </div>

        <div class="promptsEditor" aria-label="Prompt editor">
          <label class="promptsField">
            <span class="promptsFieldLabel">Name</span>
            <input v-model="draftName" :disabled="busy" placeholder="Prompt name" />
          </label>

          <label class="promptsField" style="min-height: 0">
            <span class="promptsFieldLabel">Content</span>
            <textarea v-model="draftContent" :disabled="busy" rows="12" placeholder="Prompt content..." />
          </label>
        </div>
      </div>

      <div class="promptsFooter">
        <div v-if="error" class="promptsError" :title="error">{{ error }}</div>
        <div v-else class="promptsHint">Saved in state database.</div>
        <div class="promptsHint" style="text-align: right">{{ busy ? "Working..." : "" }}</div>
      </div>
    </div>
  </div>
</template>

