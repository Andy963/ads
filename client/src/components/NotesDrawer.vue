<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Close, Search } from "@element-plus/icons-vue";

import MarkdownContent from "./MarkdownContent.vue";
import { copyTextToClipboard } from "../lib/clipboard";

export type ProjectNoteItem = {
  id: string;
  authUserId?: string;
  projectId: string;
  content: string;
  isArchived: boolean;
  createdAt: number;
  updatedAt: number;
};

type NotesApiClient = {
  get: <T>(url: string) => Promise<T>;
  post: <T>(url: string, body: unknown) => Promise<T>;
  patch: <T>(url: string, body: unknown) => Promise<T>;
  delete: <T>(url: string) => Promise<T>;
};

const props = defineProps<{
  api: NotesApiClient;
  projectId: string;
  projects: Array<{ id: string; name: string }>;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "promote", note: ProjectNoteItem): void;
}>();

const notes = ref<ProjectNoteItem[]>([]);
const loading = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);
const draft = ref("");
const search = ref("");
const showAllProjects = ref(false);
const includeArchived = ref(false);
const editingId = ref<string | null>(null);
const editDraft = ref("");
const copiedId = ref<string | null>(null);
const quickAddRef = ref<HTMLTextAreaElement | null>(null);

const projectNameById = computed(() => {
  const map = new Map<string, string>();
  for (const project of props.projects) {
    map.set(project.id, project.name || project.id);
  }
  return map;
});

const filteredNotes = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return notes.value;
  return notes.value.filter((note) => {
    const projectName = (projectNameById.value.get(note.projectId) ?? note.projectId).toLowerCase();
    return note.content.toLowerCase().includes(query) || projectName.includes(query);
  });
});

function projectLabel(projectId: string): string {
  return projectNameById.value.get(projectId) ?? projectId;
}

function formatRelativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diffMs = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}

function resizeQuickAdd(): void {
  const el = quickAddRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

async function loadNotes(): Promise<void> {
  const pid = String(props.projectId ?? "").trim();
  if (!showAllProjects.value && !pid) {
    notes.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const params = new URLSearchParams();
    if (pid) params.set("projectId", pid);
    if (showAllProjects.value) params.set("all", "true");
    if (includeArchived.value) params.set("includeArchived", "true");
    const response = await props.api.get<{ notes?: ProjectNoteItem[] }>(`/api/notes?${params.toString()}`);
    notes.value = Array.isArray(response?.notes) ? response.notes : [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载闪念失败";
  } finally {
    loading.value = false;
  }
}

async function addNote(): Promise<void> {
  const content = draft.value.trim();
  const pid = String(props.projectId ?? "").trim();
  if (!content || !pid || submitting.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const created = await props.api.post<ProjectNoteItem>("/api/notes", {
      projectId: pid,
      content,
    });
    notes.value = [created, ...notes.value];
    draft.value = "";
    await nextTick();
    resizeQuickAdd();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "保存闪念失败";
  } finally {
    submitting.value = false;
  }
}

function onQuickAddKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    void addNote();
  }
}

function beginEdit(note: ProjectNoteItem): void {
  editingId.value = note.id;
  editDraft.value = note.content;
}

function cancelEdit(): void {
  editingId.value = null;
  editDraft.value = "";
}

async function saveEdit(note: ProjectNoteItem): Promise<void> {
  const nextContent = editDraft.value.trim();
  if (!nextContent) {
    error.value = "闪念内容不能为空";
    return;
  }
  error.value = null;
  try {
    const updated = await props.api.patch<ProjectNoteItem>(`/api/notes/${encodeURIComponent(note.id)}`, {
      content: nextContent,
    });
    notes.value = notes.value.map((item) => (item.id === note.id ? updated : item));
    cancelEdit();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "更新闪念失败";
  }
}

async function toggleArchive(note: ProjectNoteItem): Promise<void> {
  error.value = null;
  try {
    const updated = await props.api.patch<ProjectNoteItem>(`/api/notes/${encodeURIComponent(note.id)}`, {
      is_archived: !note.isArchived,
    });
    if (!includeArchived.value && updated.isArchived) {
      notes.value = notes.value.filter((item) => item.id !== note.id);
    } else {
      notes.value = notes.value.map((item) => (item.id === note.id ? updated : item));
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : "归档闪念失败";
  }
}

async function deleteNote(note: ProjectNoteItem): Promise<void> {
  error.value = null;
  try {
    await props.api.delete(`/api/notes/${encodeURIComponent(note.id)}`);
    notes.value = notes.value.filter((item) => item.id !== note.id);
    if (editingId.value === note.id) cancelEdit();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "删除闪念失败";
  }
}

async function copyNote(note: ProjectNoteItem): Promise<void> {
  const ok = await copyTextToClipboard(note.content);
  if (!ok) return;
  copiedId.value = note.id;
  setTimeout(() => {
    if (copiedId.value === note.id) copiedId.value = null;
  }, 1500);
}

async function promoteNote(note: ProjectNoteItem): Promise<void> {
  error.value = null;
  try {
    const archived = note.isArchived
      ? note
      : await props.api.patch<ProjectNoteItem>(`/api/notes/${encodeURIComponent(note.id)}`, {
          is_archived: true,
        });
    const promoted: ProjectNoteItem = {
      ...note,
      ...(archived && typeof archived === "object" ? archived : {}),
      projectId: archived?.projectId || note.projectId,
      content: archived?.content || note.content,
      isArchived: true,
    };
    if (!includeArchived.value) {
      notes.value = notes.value.filter((item) => item.id !== note.id);
    } else {
      notes.value = notes.value.map((item) => (item.id === note.id ? promoted : item));
    }
    emit("promote", promoted);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "开启会话失败";
  }
}

watch([() => props.projectId, showAllProjects, includeArchived], () => {
  void loadNotes();
});

onMounted(() => {
  void loadNotes();
});
</script>

<template>
  <section class="notesDrawer" data-testid="notes-drawer" aria-label="闪念">
    <header class="notesHeader">
      <div class="notesTitleGroup">
        <h2 class="notesTitle">闪念</h2>
        <span class="notesCount">{{ filteredNotes.length }}</span>
      </div>
      <button
        type="button"
        class="notesCloseBtn"
        title="关闭"
        aria-label="关闭闪念"
        data-testid="notes-close-btn"
        @click="emit('close')"
      >
        <el-icon :size="16" aria-hidden="true"><Close /></el-icon>
      </button>
    </header>

    <div class="notesQuickAdd">
      <textarea
        ref="quickAddRef"
        v-model="draft"
        class="notesQuickInput"
        rows="2"
        placeholder="记录一个新想法... (Enter 快速添加)"
        data-testid="notes-quick-input"
        @input="resizeQuickAdd"
        @keydown="onQuickAddKeydown"
      />
      <button
        type="button"
        class="notesAddBtn"
        :disabled="submitting || !draft.trim() || !projectId"
        data-testid="notes-add-btn"
        @click="addNote"
      >
        添加
      </button>
    </div>

    <div class="notesToolbar">
      <label class="notesSearchWrap">
        <el-icon :size="14" aria-hidden="true"><Search /></el-icon>
        <input
          v-model="search"
          type="search"
          class="notesSearchInput"
          placeholder="搜索闪念..."
          data-testid="notes-search-input"
        />
      </label>
      <label class="notesToggle">
        <input v-model="showAllProjects" type="checkbox" data-testid="notes-scope-all" />
        <span>全部项目</span>
      </label>
      <label class="notesToggle">
        <input v-model="includeArchived" type="checkbox" data-testid="notes-include-archived" />
        <span>含已归档</span>
      </label>
    </div>

    <div v-if="error" class="notesError" role="alert" data-testid="notes-error">{{ error }}</div>

    <div class="notesList" data-testid="notes-list">
      <div v-if="loading && !notes.length" class="notesEmpty">正在加载闪念...</div>
      <div v-else-if="!filteredNotes.length" class="notesEmpty" data-testid="notes-empty">
        还没有闪念，想到什么随时记下来。
      </div>
      <article
        v-for="note in filteredNotes"
        :key="note.id"
        class="noteCard"
        :class="{ 'noteCard--archived': note.isArchived }"
        :data-note-id="note.id"
        data-testid="note-card"
      >
        <div class="noteMeta">
          <span class="noteProjectBadge">{{ projectLabel(note.projectId) }}</span>
          <span v-if="note.isArchived" class="noteArchivedBadge">已归档</span>
          <span class="noteTimestamp">{{ formatRelativeTime(note.updatedAt || note.createdAt) }}</span>
        </div>

        <div v-if="editingId === note.id" class="noteEditWrap">
          <textarea
            v-model="editDraft"
            class="noteEditTextarea"
            rows="3"
            data-testid="note-edit-textarea"
          />
          <div class="noteEditActions">
            <button type="button" class="noteActionBtn noteActionBtn--primary" data-testid="note-save-edit-btn" @click="saveEdit(note)">保存</button>
            <button type="button" class="noteActionBtn" data-testid="note-cancel-edit-btn" @click="cancelEdit">取消</button>
          </div>
        </div>
        <div
          v-else
          class="noteBody"
          role="button"
          tabindex="0"
          title="点击编辑"
          data-testid="note-body"
          @click="beginEdit(note)"
          @keydown.enter.prevent="beginEdit(note)"
        >
          <MarkdownContent :content="note.content" />
        </div>

        <div class="noteActions">
          <button
            type="button"
            class="noteActionBtn noteActionBtn--promote"
            data-testid="note-promote-btn"
            @click="promoteNote(note)"
          >
            开启会话
          </button>
          <button
            type="button"
            class="noteActionBtn"
            data-testid="note-copy-btn"
            @click="copyNote(note)"
          >
            {{ copiedId === note.id ? "已复制" : "复制" }}
          </button>
          <button
            type="button"
            class="noteActionBtn"
            data-testid="note-archive-btn"
            @click="toggleArchive(note)"
          >
            {{ note.isArchived ? "恢复" : "归档" }}
          </button>
          <button
            type="button"
            class="noteActionBtn noteActionBtn--danger"
            data-testid="note-delete-btn"
            @click="deleteNote(note)"
          >
            删除
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.notesDrawer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: min(76vh, 680px);
  padding: 16px;
  background: var(--surface);
  color: var(--text);
  box-sizing: border-box;
}
.notesHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.notesTitleGroup {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.notesTitle {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.notesCount {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--selection-bg);
  color: var(--accent);
  font-weight: 600;
}
.notesCloseBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.notesQuickAdd {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.notesQuickInput {
  flex: 1 1 auto;
  min-width: 0;
  resize: none;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
  line-height: 1.45;
}
.notesAddBtn {
  flex: 0 0 auto;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.notesAddBtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.notesToolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.notesSearchWrap {
  flex: 1 1 160px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
  color: var(--muted);
}
.notesSearchInput {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}
.notesToggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.notesError {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.1);
  color: #dc2626;
  font-size: 12.5px;
}
.notesList {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
}
.notesEmpty {
  padding: 28px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}
.noteCard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
}
.noteCard--archived {
  opacity: 0.72;
}
.noteMeta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
.noteProjectBadge {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--selection-bg);
  color: var(--accent);
  font-weight: 600;
}
.noteArchivedBadge {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.2);
  color: var(--muted);
}
.noteTimestamp {
  margin-left: auto;
}
.noteBody {
  font-size: 13.5px;
  line-height: 1.5;
  cursor: text;
  word-break: break-word;
}
.noteEditWrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.noteEditTextarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 13.5px;
}
.noteEditActions,
.noteActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.noteActionBtn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.noteActionBtn--promote,
.noteActionBtn--primary {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.noteActionBtn--danger {
  color: #dc2626;
}
</style>
