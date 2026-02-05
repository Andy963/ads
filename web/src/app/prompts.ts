import { ref } from "vue";

import type { ApiClient } from "../api/client";
import type { Prompt } from "../api/types";

export function createPromptActions(deps: { api: ApiClient; loggedIn: { value: boolean } }) {
  const promptsModalOpen = ref(false);
  const prompts = ref<Prompt[]>([]);
  const promptsBusy = ref(false);
  const promptsError = ref<string | null>(null);

  const loadPrompts = async (): Promise<void> => {
    if (!deps.loggedIn.value) return;
    promptsError.value = null;
    promptsBusy.value = true;
    try {
      const res = await deps.api.get<{ prompts: Prompt[] }>("/api/prompts");
      prompts.value = Array.isArray(res.prompts) ? res.prompts : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      promptsError.value = message;
    } finally {
      promptsBusy.value = false;
    }
  };

  const openPromptsModal = (): void => {
    promptsModalOpen.value = true;
    void loadPrompts();
  };

  const closePromptsModal = (): void => {
    promptsModalOpen.value = false;
    promptsError.value = null;
  };

  const createPrompt = async (input: { name: string; content: string }): Promise<Prompt | null> => {
    if (!deps.loggedIn.value) return null;
    promptsError.value = null;
    promptsBusy.value = true;
    try {
      const res = await deps.api.post<{ prompt: Prompt }>("/api/prompts", input);
      const created = res.prompt;
      if (created && created.id) {
        prompts.value = [created, ...prompts.value.filter((p) => p.id !== created.id)];
        return created;
      }
      await loadPrompts();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      promptsError.value = message;
      return null;
    } finally {
      promptsBusy.value = false;
    }
  };

  const updatePrompt = async (id: string, input: { name: string; content: string }): Promise<Prompt | null> => {
    if (!deps.loggedIn.value) return null;
    const pid = String(id ?? "").trim();
    if (!pid) return null;
    promptsError.value = null;
    promptsBusy.value = true;
    try {
      const res = await deps.api.patch<{ prompt: Prompt }>(`/api/prompts/${encodeURIComponent(pid)}`, input);
      const updated = res.prompt;
      if (updated && updated.id) {
        prompts.value = prompts.value.map((p) => (p.id === updated.id ? updated : p));
        return updated;
      }
      await loadPrompts();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      promptsError.value = message;
      return null;
    } finally {
      promptsBusy.value = false;
    }
  };

  const deletePrompt = async (id: string): Promise<boolean> => {
    if (!deps.loggedIn.value) return false;
    const pid = String(id ?? "").trim();
    if (!pid) return false;
    promptsError.value = null;
    promptsBusy.value = true;
    try {
      const res = await deps.api.delete<{ success: boolean }>(`/api/prompts/${encodeURIComponent(pid)}`);
      const ok = Boolean(res && (res as any).success === true);
      if (ok) {
        prompts.value = prompts.value.filter((p) => p.id !== pid);
      } else {
        await loadPrompts();
      }
      return ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      promptsError.value = message;
      return false;
    } finally {
      promptsBusy.value = false;
    }
  };

  return {
    promptsModalOpen,
    prompts,
    promptsBusy,
    promptsError,
    loadPrompts,
    openPromptsModal,
    closePromptsModal,
    createPrompt,
    updatePrompt,
    deletePrompt,
  };
}

