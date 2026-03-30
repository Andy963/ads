import { computed, ref } from "vue";

import type {
  TaskBundleDraft,
  TaskBundleDraftSpecDocument,
  TaskBundleDraftSpecFileKey,
  TaskBundleDraftSpecFileUpdate,
  TaskBundleDraftSpecSummary,
} from "../../api/types";

export type LoadSpecSummaryHandler = (draftId: string) => Promise<TaskBundleDraftSpecSummary | null>;
export type LoadSpecFileHandler = (payload: { id: string; file: TaskBundleDraftSpecFileKey }) => Promise<TaskBundleDraftSpecDocument | null>;
export type SaveSpecFileHandler = (payload: {
  id: string;
  file: TaskBundleDraftSpecFileKey;
  update: TaskBundleDraftSpecFileUpdate;
}) => Promise<TaskBundleDraftSpecDocument | null>;

type SpecBusyState = Partial<Record<TaskBundleDraftSpecFileKey, "loading" | "saving">>;
type SpecDocState = Partial<Record<TaskBundleDraftSpecFileKey, string>>;

export function useDraftSpecEditor() {
  const specSummary = ref<TaskBundleDraftSpecSummary | null>(null);
  const specSummaryLoading = ref(false);
  const specDocuments = ref<SpecDocState>({});
  const specBusy = ref<SpecBusyState>({});
  const specDirty = ref(new Set<TaskBundleDraftSpecFileKey>());
  const specError = ref<string | null>(null);
  const specRequestToken = ref(0);

  const hasPendingSpecRequest = computed(
    () => specSummaryLoading.value || Object.keys(specBusy.value).length > 0,
  );

  function resetSpecState(): void {
    specSummary.value = null;
    specSummaryLoading.value = false;
    specDocuments.value = {};
    specBusy.value = {};
    specDirty.value = new Set();
    specError.value = null;
  }

  function invalidateSpecRequests(): void {
    specRequestToken.value += 1;
  }

  function setSpecBusy(
    file: TaskBundleDraftSpecFileKey,
    state: "loading" | "saving" | null,
  ): void {
    const next = { ...specBusy.value };
    if (state === null) {
      delete next[file];
    } else {
      next[file] = state;
    }
    specBusy.value = next;
  }

  function setCurrentSpecContent(file: TaskBundleDraftSpecFileKey, value: string): void {
    specDocuments.value = { ...specDocuments.value, [file]: value };
    specDirty.value = new Set([...specDirty.value, file]);
  }

  async function ensureSpecSummaryLoaded(
    draft: TaskBundleDraft | null,
    loadSpecSummary?: LoadSpecSummaryHandler,
  ): Promise<void> {
    if (!draft || specSummary.value || specSummaryLoading.value || !loadSpecSummary) {
      return;
    }
    const specRef = String(draft.bundle?.specRef ?? "").trim();
    if (!specRef) return;

    const token = ++specRequestToken.value;
    specSummaryLoading.value = true;
    specError.value = null;
    try {
      const loaded = await loadSpecSummary(draft.id);
      if (token !== specRequestToken.value) return;
      if (!loaded) {
        specError.value = "未能加载 spec 内容";
        return;
      }
      specSummary.value = loaded;
    } catch (error) {
      if (token !== specRequestToken.value) return;
      specError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === specRequestToken.value) {
        specSummaryLoading.value = false;
      }
    }
  }

  async function ensureSpecFileLoaded(
    draft: TaskBundleDraft | null,
    file: TaskBundleDraftSpecFileKey,
    loadSpecFile?: LoadSpecFileHandler,
    options?: { force?: boolean },
  ): Promise<void> {
    if (!draft || !loadSpecFile) return;
    if (!options?.force && specDocuments.value[file] !== undefined) return;

    const token = ++specRequestToken.value;
    setSpecBusy(file, "loading");
    specError.value = null;
    try {
      const loaded = await loadSpecFile({ id: draft.id, file });
      if (token !== specRequestToken.value) return;
      if (!loaded) {
        specError.value = "未能加载 spec 内容";
        return;
      }
      specDocuments.value = { ...specDocuments.value, [file]: loaded.content };
      if (loaded.missing && specSummary.value) {
        specSummary.value = {
          ...specSummary.value,
          files: specSummary.value.files.map((entry) =>
            entry.key === file ? { ...entry, missing: true } : entry,
          ),
        };
      }
      const nextDirty = new Set(specDirty.value);
      nextDirty.delete(file);
      specDirty.value = nextDirty;
    } catch (error) {
      if (token !== specRequestToken.value) return;
      specError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === specRequestToken.value) {
        setSpecBusy(file, null);
      }
    }
  }

  async function saveCurrentSpecFile(
    draft: TaskBundleDraft | null,
    file: TaskBundleDraftSpecFileKey | null,
    saveSpecFile?: SaveSpecFileHandler,
  ): Promise<void> {
    if (!draft || !file || !saveSpecFile) return;
    if (!specDirty.value.has(file)) return;

    setSpecBusy(file, "saving");
    specError.value = null;
    try {
      const saved = await saveSpecFile({
        id: draft.id,
        file,
        update: { content: specDocuments.value[file] ?? "" },
      });
      if (!saved) {
        specError.value = "未能保存 spec 内容";
        return;
      }
      specDocuments.value = { ...specDocuments.value, [file]: saved.content };
      if (specSummary.value) {
        specSummary.value = {
          ...specSummary.value,
          files: specSummary.value.files.map((entry) =>
            entry.key === file ? { ...entry, missing: saved.missing } : entry,
          ),
        };
      }
      const nextDirty = new Set(specDirty.value);
      nextDirty.delete(file);
      specDirty.value = nextDirty;
    } catch (error) {
      specError.value = error instanceof Error ? error.message : String(error);
    } finally {
      setSpecBusy(file, null);
    }
  }

  return {
    specSummary,
    specSummaryLoading,
    specDocuments,
    specBusy,
    specDirty,
    specError,
    hasPendingSpecRequest,
    resetSpecState,
    invalidateSpecRequests,
    setCurrentSpecContent,
    ensureSpecSummaryLoaded,
    ensureSpecFileLoaded,
    saveCurrentSpecFile,
  };
}
