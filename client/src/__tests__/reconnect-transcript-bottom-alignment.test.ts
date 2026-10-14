import { describe, expect, it } from "vitest";
import { nextTick, ref, watch } from "vue";
import { mount } from "@vue/test-utils";
import fs from "node:fs";
import path from "node:path";

import MainChat from "../components/MainChat.vue";
import type { ChatMessage } from "../components/mainChat/types";
import { createProjectRuntime } from "../app/projectRuntime";
import { createChatActions } from "../app/chat";

function msg(id: string, role: "user" | "assistant" | "system", content: string, streaming = false): ChatMessage {
  return { id, role, kind: "text", content, ts: 1, streaming };
}

describe("Issue #559: reconnect transcript bottom alignment and atomic history replacement", () => {
  it("does not momentarily empty rt.messages to [] when applying authoritative history snapshot", async () => {
    const rt = createProjectRuntime({ maxLiveActivitySteps: 10 });
    rt.projectSessionId = "p1";
    rt.chatSessionId = "main";
    rt.messages.value = [
      msg("u-1", "user", "existing question"),
      msg("a-1", "assistant", "existing answer"),
    ];
    rt.latestExecuteKey = "old-exec";
    rt.latestExecuteSequence = 42;
    rt.latestExecuteTimestamp = 1000;
    rt.retiredExecuteKeys.add("old-retired");
    rt.seenCommandIds.add("old-cmd");
    rt.recentCommands.value = ["$ ls"];
    rt.executeOrder = ["old-exec"];

    const observedLengths: number[] = [];
    const chat = createChatActions({ runtimeOrActive: (target?: any) => target ?? rt } as any);

    watch(
      rt.messages,
      (current) => {
        observedLengths.push(current.length);
      },
      { flush: "sync" },
    );

    // Apply authoritative history through applyResumeHistory with authoritative flag
    chat.applyResumeHistory(
      [
        msg("u-snapshot", "user", "snapshot question"),
        msg("a-snapshot", "assistant", "snapshot answer"),
      ],
      rt,
      { authoritative: true },
    );

    expect(observedLengths).toEqual([2]);
    expect(rt.messages.value.map((m) => m.content)).toEqual(["snapshot question", "snapshot answer"]);
    // Confirm 0 was never observed
    expect(observedLengths).not.toContain(0);
    // Confirm execution state was completely reset
    expect(rt.latestExecuteKey).toBeUndefined();
    expect(rt.latestExecuteSequence).toBeUndefined();
    expect(rt.latestExecuteTimestamp).toBeUndefined();
    expect(rt.retiredExecuteKeys.size).toBe(0);
    expect(rt.seenCommandIds.size).toBe(0);
    expect(rt.recentCommands.value).toEqual([]);
    expect(rt.executeOrder).toEqual([]);
  });

  it("never publishes an empty message array when current transcript contains transient live-activity/thought rows before snapshot", async () => {
    const rt = createProjectRuntime({ maxLiveActivitySteps: 10 });
    rt.projectSessionId = "p1";
    rt.chatSessionId = "main";
    rt.messages.value = [
      { id: "live-activity", role: "assistant", kind: "thought", content: "thinking...", ts: 1 },
    ];

    const observedLengths: number[] = [];
    const chat = createChatActions({ runtimeOrActive: (target?: any) => target ?? rt } as any);

    watch(
      rt.messages,
      (current) => {
        observedLengths.push(current.length);
      },
      { flush: "sync" },
    );

    chat.applyResumeHistory(
      [
        msg("u-snapshot", "user", "snapshot question"),
        msg("a-snapshot", "assistant", "snapshot answer"),
      ],
      rt,
      { authoritative: true },
    );

    expect(observedLengths).toEqual([2]);
    expect(observedLengths).not.toContain(0);
    expect(rt.messages.value.map((m) => m.content)).toEqual(["snapshot question", "snapshot answer"]);
  });

  it("does not publish an empty array when reconnect notice was present before authoritative snapshot", async () => {
    const rt = createProjectRuntime({ maxLiveActivitySteps: 10 });
    rt.projectSessionId = "p1";
    rt.chatSessionId = "main";
    rt.messages.value = [
      { id: "notice", role: "system", kind: "text", content: "Connection lost while a request was running. Reconnecting and syncing history…" },
    ];

    const observedLengths: number[] = [];
    const chat = createChatActions({ runtimeOrActive: (target?: any) => target ?? rt } as any);

    watch(
      rt.messages,
      (current) => {
        observedLengths.push(current.length);
      },
      { flush: "sync" },
    );

    chat.applyResumeHistory(
      [
        msg("u-snapshot", "user", "snapshot question"),
        msg("a-snapshot", "assistant", "snapshot answer"),
      ],
      rt,
      { authoritative: true },
    );

    expect(observedLengths).toEqual([2]);
    expect(observedLengths).not.toContain(0);
    expect(rt.messages.value.map((m) => m.content)).toEqual(["snapshot question", "snapshot answer"]);
  });

  it("preserves activeThreadId and in-flight inputLocked when applying authoritative snapshot during in-flight reconnect", async () => {
    const rt = createProjectRuntime({ maxLiveActivitySteps: 10 });
    rt.projectSessionId = "p1";
    rt.chatSessionId = "main";
    rt.activeThreadId.value = "thread-active-123";
    rt.inputLocked.value = true;
    rt.laneStatus.value = { kind: "progress", message: "In flight" };

    const chat = createChatActions({ runtimeOrActive: (target?: any) => target ?? rt } as any);

    chat.applyResumeHistory(
      [
        msg("u-1", "user", "task in flight"),
        msg("a-1", "assistant", "partial text", true),
      ],
      rt,
      { authoritative: true },
    );

    expect(rt.activeThreadId.value).toBe("thread-active-123");
    expect(rt.inputLocked.value).toBe(true);
    expect(rt.laneStatus.value).toEqual({ kind: "progress", message: "In flight" });
  });

  it("restores autoScroll and aligns to bottom upon reconnection when user was previously at bottom", async () => {
    const initialMessages: ChatMessage[] = [
      msg("u-1", "user", "hello"),
      msg("a-1", "assistant", "world"),
    ];
    const messages = ref<ChatMessage[]>([...initialMessages]);
    const connected = ref(true);
    const transcriptAlignSeq = ref(0);

    const wrapper = mount(MainChat, {
      props: {
        messages: messages.value,
        connected: connected.value,
        transcriptAlignSeq: transcriptAlignSeq.value,
        queuedPrompts: [],
        pendingImages: [],
        busy: false,
      },
      global: {
        stubs: { MarkdownContent: true, ChatFilePreviewModal: true },
      },
      attachTo: document.body,
    });

    const host = wrapper.find(".chat").element as HTMLElement;
    let currentScrollTop = 500;
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => currentScrollTop,
        set: (v: number) => { currentScrollTop = v; },
      },
    });

    // Initial state: at bottom (scrollHeight 1000, clientHeight 500, scrollTop 500 => distance 0 < 80)
    currentScrollTop = 500;
    await host.dispatchEvent(new Event("scroll"));
    await nextTick();

    // Disconnect
    connected.value = false;
    await wrapper.setProps({ connected: false });
    await nextTick();

    // Reconnection occurs with new message delta (large delta > 2)
    connected.value = true;
    const newMessages: ChatMessage[] = [
      ...initialMessages,
      msg("u-2", "user", "next question"),
      msg("a-2", "assistant", "next answer 1"),
      msg("a-3", "assistant", "next answer 2"),
    ];
    await wrapper.setProps({
      connected: true,
      messages: newMessages,
    });
    await nextTick();
    await nextTick();

    // Trigger explicit bottom alignment pass
    transcriptAlignSeq.value += 1;
    await wrapper.setProps({ transcriptAlignSeq: transcriptAlignSeq.value });
    await nextTick();
    await nextTick();

    // Confirm that scrollTop was set to scrollHeight and is NOT 0
    expect(currentScrollTop).toBe(1000);
    expect(currentScrollTop).not.toBe(0);

    wrapper.unmount();
  });

  it("preserves reading lock during in-flight streaming answer on reconnect", async () => {
    const streamingMessages: ChatMessage[] = [
      msg("u-1", "user", "generate code"),
      msg("a-1", "assistant", "first chunk", true),
    ];
    const messages = ref<ChatMessage[]>([...streamingMessages]);
    const connected = ref(true);
    const transcriptAlignSeq = ref(0);

    const wrapper = mount(MainChat, {
      props: {
        messages: messages.value,
        connected: connected.value,
        transcriptAlignSeq: transcriptAlignSeq.value,
        queuedPrompts: [],
        pendingImages: [],
        busy: true,
      },
      global: {
        stubs: { MarkdownContent: true, ChatFilePreviewModal: true },
      },
      attachTo: document.body,
    });

    const host = wrapper.find(".chat").element as HTMLElement;
    let currentScrollTop = 100;
    Object.defineProperties(host, {
      scrollHeight: { configurable: true, get: () => 2000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => currentScrollTop,
        set: (v: number) => { currentScrollTop = v; },
      },
    });

    await nextTick();
    await nextTick();

    // Disconnect while streaming
    connected.value = false;
    await wrapper.setProps({ connected: false });
    await nextTick();

    // Reconnect with streamed continuation
    connected.value = true;
    messages.value = [
      msg("u-1", "user", "generate code"),
      msg("a-1", "assistant", "first chunk and second chunk", true),
    ];
    await wrapper.setProps({
      connected: true,
      messages: messages.value,
    });
    await nextTick();
    await nextTick();

    // Explicit bottom alignment pass is triggered on reconnect
    transcriptAlignSeq.value += 1;
    await wrapper.setProps({ transcriptAlignSeq: transcriptAlignSeq.value });
    await nextTick();
    await nextTick();

    // Scroll to bottom button should appear because reading lock is engaged
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);
    expect(currentScrollTop).toBeLessThan(2000);

    wrapper.unmount();
  });

  it("verifies hardware layer promotion and momentum scrolling in CSS", () => {
    const mainChatCss = fs.readFileSync(path.resolve(__dirname, "../components/MainChat.css"), "utf-8");
    const appCss = fs.readFileSync(path.resolve(__dirname, "../App.css"), "utf-8");

    expect(mainChatCss).toContain("transform: translateZ(0)");
    expect(mainChatCss).toContain("-webkit-overflow-scrolling: touch");
    expect(appCss).toContain("transform: translateZ(0)");
    expect(appCss).toContain("-webkit-overflow-scrolling: touch");
  });
});
