<script setup lang="ts">
import DraggableModal from "./DraggableModal.vue";

type PendingImagePreview = {
  key: string;
  src: string;
  href: string;
};

const props = defineProps<{
  previews: PendingImagePreview[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();
</script>

<template>
  <DraggableModal card-variant="large" @close="emit('close')">
    <div class="attachmentsViewer">
      <div class="attachmentsViewerHeader" data-drag-handle>
        <div class="attachmentsViewerTitle">附件预览</div>
        <button class="attachmentsViewerClose" type="button" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
      </div>
      <div class="attachmentsViewerBody">
        <div class="attachmentsViewerImages">
          <template v-for="img in props.previews" :key="img.key">
            <img v-if="img.src" class="attachmentsViewerImg" :src="img.src" alt="" />
          </template>
        </div>
      </div>
    </div>
  </DraggableModal>
</template>

<style scoped>
.attachmentsViewer {
  display: flex;
  flex-direction: column;
  width: min(900px, 96vw);
  max-height: 88vh;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
}

.attachmentsViewerHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.attachmentsViewerTitle {
  font-size: 12px;
  color: #64748b;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.attachmentsViewerClose {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(15, 23, 42, 0.04);
  color: #64748b;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
}

.attachmentsViewerClose:hover {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.06);
}

.attachmentsViewerBody {
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px;
  overflow: auto;
  background: var(--surface-2);
}

.attachmentsViewerImages {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.attachmentsViewerImg {
  max-width: 100%;
  max-height: 62vh;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: #fff;
}
</style>
