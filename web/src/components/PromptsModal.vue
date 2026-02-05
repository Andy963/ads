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
    <div class="modalCard promptsModal" data-testid="prompts-modal">
      <div class="promptsHeader">
        <div class="promptsTitle">Prompts</div>
        <button type="button" class="promptsCloseBtn" title="Close" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>

      <div class="promptsBody">
        <div class="promptsList" aria-label="Prompt list">
          <div class="promptsListHeader">
            <span>Library</span>
            <button type="button" class="promptsNewBtn" :disabled="busy" title="New" data-testid="prompts-new" @click="onNew">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
              </svg>
            </button>
          </div>
          <div class="promptsListItems">
            <div v-if="!prompts.length" class="promptsEmpty">
              No prompts yet. Click + to create one.
            </div>
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
            <input v-model="draftName" class="promptsInput" :disabled="busy" placeholder="Prompt name" data-testid="prompts-name" />
          </label>

          <label class="promptsField promptsFieldGrow">
            <span class="promptsFieldLabel">Content</span>
            <textarea
              v-model="draftContent"
              class="promptsTextarea"
              :disabled="busy"
              rows="12"
              placeholder="Prompt content..."
              data-testid="prompts-content"
            />
          </label>
        </div>
      </div>

      <div class="promptsFooter">
        <div class="promptsFooterLeft">
          <div v-if="error" class="promptsError" :title="error">{{ error }}</div>
          <div v-else class="promptsHint">{{ busy ? "Working..." : "" }}</div>
        </div>
        <div class="promptsFooterRight">
          <button type="button" class="promptsBtn danger" :disabled="!canDelete" data-testid="prompts-delete" @click="onDelete">Delete</button>
          <button type="button" class="promptsBtn primary" :disabled="!canSave" data-testid="prompts-save" @click="onSave">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>
