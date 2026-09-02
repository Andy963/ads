<script setup lang="ts">
import { Delete, Refresh } from "@element-plus/icons-vue";

import type { TaskBundleDraft } from "../../api/types";

function issueRefOf(draft: TaskBundleDraft): string {
  return String(draft.bundle?.issueRef ?? "").trim();
}

function specRefOf(draft: TaskBundleDraft): string {
  return String(draft.bundle?.specRef ?? "").trim();
}

function hasAnyRef(draft: TaskBundleDraft): boolean {
  return Boolean(issueRefOf(draft) || specRefOf(draft));
}

function refSummaryOf(draft: TaskBundleDraft): string {
  return [issueRefOf(draft), specRefOf(draft)].filter(Boolean).join(" ↔ ");
}

function workItemKeyOf(draft: TaskBundleDraft): string {
  const ref = issueRefOf(draft) || specRefOf(draft);
  return ref ? (ref.split("/").pop() ?? ref) : "";
}

const props = defineProps<{
  drafts: TaskBundleDraft[];
  busy?: boolean;
  error?: string | null;
  expanded: boolean;
  draftCount: number;
  hasDrafts: boolean;
  draftTitle: (draft: TaskBundleDraft) => string;
}>();

const emit = defineEmits<{
  (e: "toggle"): void;
  (e: "refresh"): void;
  (e: "open", draft: TaskBundleDraft): void;
  (e: "delete", id: string): void;
}>();
</script>

<template>
  <section class="draftPanel" data-testid="task-bundle-drafts">
    <header class="draftHeader">
      <button
        type="button"
        class="draftToggle"
        :aria-expanded="expanded"
        data-testid="task-bundle-drafts-toggle"
        @click="emit('toggle')"
      >
        <span class="draftTitle">任务草稿</span>
        <span class="draftCount" :class="{ 'draftCount--active': hasDrafts }">{{ draftCount }}</span>
      </button>

      <div class="draftHeaderActions">
        <button
          type="button"
          class="draftIconButton"
          :disabled="Boolean(busy)"
          data-testid="task-bundle-drafts-refresh"
          title="刷新"
          @click="emit('refresh')"
        >
          <Refresh />
        </button>
      </div>
    </header>

    <div v-if="expanded" class="draftBody">
      <div v-if="error" class="draftError" data-testid="task-bundle-drafts-error">{{ error }}</div>
      <div v-else-if="!hasDrafts" class="draftEmpty">暂无草稿</div>

      <div v-else class="draftList">
        <div
          v-for="draft in drafts"
          :key="draft.id"
          class="draftRow"
          :data-testid="`task-bundle-draft-${draft.id}`"
          @click="emit('open', draft)"
        >
          <div class="draftRowLeft">
            <span class="draftRowTitle">{{ draftTitle(draft) }}</span>
            <span
              v-if="issueRefOf(draft) && specRefOf(draft)"
              class="draftRowSpec"
              :title="`${issueRefOf(draft)} ↔ ${specRefOf(draft)}`"
              data-testid="task-bundle-draft-row-spec"
            >
              📁 {{ workItemKeyOf(draft) }}
            </span>
            <span
              v-else-if="hasAnyRef(draft)"
              class="draftRowSpec"
              :title="refSummaryOf(draft)"
              data-testid="task-bundle-draft-row-ref"
            >
              🔗 {{ workItemKeyOf(draft) || "GitHub 引用" }}
            </span>
            <span
              v-else
              class="draftRowSpec"
              title="此草稿不要求本地 issue/spec 目录引用"
              data-testid="task-bundle-draft-row-prompt-only"
            >
              📝 自包含任务
            </span>
            <span v-if="draft.degradeReason" class="draftRowDegraded" :title="draft.degradeReason">⚠️ 已降级</span>
          </div>
          <div class="draftRowRight">
            <button
              type="button"
              class="draftRowDelete"
              :disabled="Boolean(busy)"
              title="删除"
              data-testid="task-bundle-draft-delete"
              @click.stop="emit('delete', draft.id)"
            >
              <Delete />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
