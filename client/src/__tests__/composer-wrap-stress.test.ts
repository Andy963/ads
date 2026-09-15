/**
 * Adversarial stress test for the iOS-only composer crash
 * ("Maximum call stack size exceeded" / patchClass(el=null) at the wrap
 * boundary). Hammers MainChatComposerPanel with the exact concurrent signals
 * seen on device: per-keystroke draft echo, composerExpanded flips (via "\n"),
 * busy flips (stop/send button swap), runningTaskCount badge toggles,
 * connection status bar toggles, queue/attachment bar toggles — batched into
 * the same flush to reproduce the patch collision.
 *
 * jsdom has no layout engine, so the soft-wrap trigger is emulated by newlines
 * (autosizeTextarea returns true whenever the value contains "\n").
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref, type Ref } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

type HostProps = {
  busy: Ref<boolean>;
  runningTaskCount: Ref<number>;
  connectionStatusMessage: Ref<string | null>;
  queuedCount: Ref<number>;
  pendingImages: Ref<Array<{ data: string }>>;
};

const StressHost = defineComponent({
  components: { MainChatComposerPanel },
  setup() {
    const draft = ref("");
    const busy = ref(false);
    const runningTaskCount = ref(0);
    const connectionStatusMessage = ref<string | null>(null);
    const queuedCount = ref(0);
    const pendingImages = ref<Array<{ data: string }>>([]);
    const sent = ref<string[]>([]);
    return {
      draft,
      busy,
      runningTaskCount,
      connectionStatusMessage,
      queuedCount,
      pendingImages,
      sent,
    };
  },
  template: `
    <div class="detail"><div class="chat"></div>
    <MainChatComposerPanel
      v-model:draft="draft"
      :queued-prompts="Array.from({ length: queuedCount }, (_, i) => ({ id: 'q' + i, text: 'queued ' + i, imagesCount: 0 }))"
      :pending-images="pendingImages"
      :connected="true"
      :busy="busy"
      :running-task-count="runningTaskCount"
      :connection-status-kind="connectionStatusMessage ? 'progress' : null"
      :connection-status-message="connectionStatusMessage"
      @send="sent.push($event)"
    />
    </div>
  `,
});

function typeText(el: HTMLTextAreaElement, text: string): void {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("composer wrap stress (iOS crash repro)", () => {
  it("survives concurrent draft/busy/status/queue churn across wrap boundaries", async () => {
    const errors: Array<{ message: string }> = [];
    const wrapper = mount(StressHost, {
      global: {
        config: {
          errorHandler: (err) => {
            errors.push({ message: err instanceof Error ? err.message : String(err) });
          },
        },
      },
      attachTo: document.body,
    });
    try {
      const textarea = wrapper.find("textarea");
      expect(textarea.exists()).toBe(true);
      const el = textarea.element as HTMLTextAreaElement;
      const vm = wrapper.vm as unknown as HostProps & { draft: string };

      let draft = "";
      for (let round = 0; round < 300; round += 1) {
        // Type a few characters per round; cross a "wrap" boundary every ~10 chars.
        for (let i = 0; i < 4; i += 1) {
          draft += round % 3 === 0 && i === 2 ? "\n" : "x";
          typeText(el, draft);
        }
        // Batch the signals that arrive over ws while the user types.
        vm.busy = !vm.busy;
        vm.runningTaskCount = vm.busy ? (round % 3) + 1 : 0;
        vm.connectionStatusMessage = round % 7 === 0 ? (vm.connectionStatusMessage ? null : "重连中…") : vm.connectionStatusMessage;
        vm.queuedCount = vm.busy ? round % 4 : 0;
        vm.pendingImages = round % 11 === 0 ? [{ data: "data:image/png;base64,AAAA" }] : vm.pendingImages;
        if (round % 11 === 5) vm.pendingImages = [];
        if (draft.length > 400) draft = draft.slice(-120);
        await nextTick();
        // Type again immediately after the flush, while post-watchers run.
        draft += "y";
        typeText(el, draft);
        await nextTick();
      }
      expect(errors).toEqual([]);
    } finally {
      wrapper.unmount();
    }
  }, 60000);
});
