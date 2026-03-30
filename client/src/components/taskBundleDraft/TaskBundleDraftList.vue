<script setup lang="ts">
import { Delete, Refresh } from "@element-plus/icons-vue";

import type { TaskBundleDraft } from "../../api/types";

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
