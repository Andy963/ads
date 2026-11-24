import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import NotesDrawer, { type ProjectNoteItem } from "../components/NotesDrawer.vue";

vi.mock("../lib/clipboard", () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

function createMockApi(initial: ProjectNoteItem[]) {
  let store = [...initial];
  return {
    get: vi.fn(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const projectId = params.get("projectId");
      const all = params.get("all") === "true";
      const includeArchived = params.get("includeArchived") === "true";
      const notes = store.filter((note) => {
        if (!all && projectId && note.projectId !== projectId) return false;
        if (!includeArchived && note.isArchived) return false;
        return true;
      });
      return { notes };
    }),
    post: vi.fn(async (_url: string, body: { projectId: string; content: string }) => {
      const created: ProjectNoteItem = {
        id: `note-${store.length + 1}`,
        projectId: body.projectId,
        content: body.content,
        isArchived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store = [created, ...store];
      return created;
    }),
    patch: vi.fn(async (url: string, body: { content?: string; is_archived?: boolean }) => {
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      store = store.map((note) =>
        note.id === id
          ? {
              ...note,
              content: body.content ?? note.content,
              isArchived: body.is_archived ?? note.isArchived,
              updatedAt: Date.now(),
            }
          : note,
      );
      return store.find((note) => note.id === id)!;
    }),
    delete: vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      store = store.filter((note) => note.id !== id);
      return { success: true };
    }),
  };
}

describe("NotesDrawer", () => {
  it("supports creating, filtering, searching, editing, copying, promoting, and deleting notes", async () => {
    const api = createMockApi([
      {
        id: "note-a",
        projectId: "proj-a",
        content: "Fix **timeout** watchdog",
        isArchived: false,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      },
      {
        id: "note-b",
        projectId: "proj-b",
        content: "Other project idea",
        isArchived: false,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
      },
    ]);

    const wrapper = mount(NotesDrawer, {
      props: {
        api,
        projectId: "proj-a",
        projects: [
          { id: "proj-a", name: "ads" },
          { id: "proj-b", name: "study" },
        ],
      },
    });
    await flushPromises();

    expect(wrapper.findAll('[data-testid="note-card"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="note-card"]').text()).toContain("timeout");
    expect(wrapper.get('[data-testid="note-card"]').text()).toContain("watchdog");

    const input = wrapper.get('[data-testid="notes-quick-input"]');
    await input.setValue("Add quick notes shortcut");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith("/api/notes", {
      projectId: "proj-a",
      content: "Add quick notes shortcut",
    });
    expect(wrapper.findAll('[data-testid="note-card"]')).toHaveLength(2);

    await wrapper.findAll('[data-testid="note-body"]')[0]!.trigger("click");
    await wrapper.get('[data-testid="note-edit-textarea"]').setValue("Add quick notes shortcut v2");
    await wrapper.get('[data-testid="note-save-edit-btn"]').trigger("click");
    await flushPromises();
    expect(api.patch).toHaveBeenCalledWith("/api/notes/note-3", {
      content: "Add quick notes shortcut v2",
    });

    await wrapper.findAll('[data-testid="note-copy-btn"]')[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="note-copy-btn"]')[0]!.text()).toBe("已复制");

    await wrapper.findAll('[data-testid="note-promote-btn"]')[0]!.trigger("click");
    await flushPromises();
    expect(api.patch).toHaveBeenCalledWith("/api/notes/note-3", { is_archived: true });
    expect(wrapper.emitted("promote")?.[0]?.[0]).toMatchObject({
      id: "note-3",
      content: "Add quick notes shortcut v2",
      isArchived: true,
    });

    await wrapper.get('[data-testid="notes-scope-all"]').setValue(true);
    await flushPromises();
    expect(wrapper.findAll('[data-testid="note-card"]')).toHaveLength(2);

    await wrapper.get('[data-testid="notes-search-input"]').setValue("Other project");
    expect(wrapper.findAll('[data-testid="note-card"]')).toHaveLength(1);
    await wrapper.get('[data-testid="notes-search-input"]').setValue("");

    await wrapper.findAll('[data-testid="note-delete-btn"]')[0]!.trigger("click");
    await flushPromises();
    expect(api.delete).toHaveBeenCalled();
    expect(wrapper.findAll('[data-testid="note-card"]')).toHaveLength(1);

    wrapper.unmount();
  });
});
