import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import MainChat from "../components/MainChat.vue";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

function selectors_rule(css: string, selector: string): string {
  return css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

describe("MainChat header UI", () => {
  it("keeps lane and model controls in one continuous header surface", () => {
    const css = readUtf8("../App.css");
    const selectors = readUtf8("../components/MainChatModelSelectors.vue");
    const surface = css.match(/\.laneTabs\s*\{[^}]*\}/)?.[0];
    const group = css.match(/\.laneTabGroup\s*\{[^}]*\}/)?.[0];
    const divider = css.match(/\.laneControlDivider\s*\{[^}]*\}/)?.[0];
    const controls = css.match(/\.laneModelControls\s*\{[^}]*\}/)?.[0];

    // The bar itself is the only painted surface: one border, one radius, one fill.
    expect(surface).toMatch(/gap:\s*0\s*;/);
    expect(surface).toMatch(/overflow:\s*hidden\s*;/);
    expect(surface).toMatch(/padding:\s*3px\s*;/);
    expect(surface).toMatch(/border-radius:\s*12px\s*;/);
    expect(surface).toMatch(/background:\s*rgba\(15, 23, 42, 0\.05\)\s*;/);
    expect(surface).not.toMatch(/border-bottom:\s*1px/);

    // The lane group is a bare slot inside that surface, not a second box.
    expect(group).toMatch(/display:\s*inline-flex\s*;/);
    expect(group).not.toMatch(/background:/);
    expect(group).not.toMatch(/border:/);
    expect(group).not.toMatch(/border-radius:/);
    expect(group).not.toMatch(/padding:/);

    // Separation is a short hairline inside the surface, never a full-height rule.
    expect(divider).toBeDefined();
    expect(divider).toMatch(/flex:\s*0 0 1px\s*;/);
    expect(divider).toMatch(/height:\s*18px\s*;/);
    expect(divider).toMatch(/align-self:\s*center\s*;/);
    expect(controls).toMatch(/border-left:\s*none\s*;/);
    expect(controls).not.toMatch(/border-left:\s*1px/);
    expect(controls).toMatch(/padding-left:\s*0\s*;/);
    expect(controls).toMatch(/min-width:\s*0\s*;/);
    expect(controls).toMatch(/flex:\s*1 1 0\s*;/);
    expect(controls).toMatch(/margin-left:\s*0\s*;/);
    expect(controls).toMatch(/justify-content:\s*flex-end\s*;/);

    // Every segment in the surface is exactly as tall as the lane tab.
    const tab = css.match(/\.laneTab\s*\{[^}]*\}/)?.[0];
    expect(tab).toMatch(/min-height:\s*28px\s*;/);
    const capsule = selectors_rule(readUtf8("../components/MainChatModelSelectors.vue"), ".modelCapsule");
    expect(capsule).toMatch(/height:\s*28px\s*;/);
    expect(capsule).toMatch(/background:\s*transparent\s*;/);
    expect(capsule).toMatch(/border:\s*1px solid transparent\s*;/);

    expect(css).not.toMatch(/\.laneTab\s*\{[^}]*justify-self\s*;/);
    expect(selectors.match(/<select\s/g)).toHaveLength(2);
    expect(selectors).toMatch(/\.modelSelect\s*\{[^}]*width:\s*100%\s*;[^}]*min-width:\s*0\s*;/);
    expect(selectors).toMatch(/\.modelField\s*\{[^}]*height:\s*28px\s*;[^}]*font-size:\s*12px\s*;/);
    expect(selectors).toMatch(/\.modelSelect\s*\{[^}]*font-size:\s*16px\s*;/);
    expect(css).toMatch(/\.laneTab\s*\{[^}]*font-size:\s*13px\s*;/);
    expect(selectors).not.toContain('role="dialog"');
    const app = readUtf8("../App.vue");
    expect(app).toContain('data-testid="chat-control-surface"');
    const header = app.match(/<header class="topbar">([\s\S]*?)<\/header>/)?.[1];
    expect(header).toContain('data-testid="lane-new-session"');
    expect(app.slice(app.indexOf('class="laneTabGroup"'))).not.toContain('class="laneSessionActions"');
  });

  it("compacts both desktop and mobile navigation", () => {
    const css = readUtf8("../App.css");
    const mobileCss = css.slice(css.indexOf("@media (max-width: 900px)"));
    const app = css.match(/\.app\s*\{[^}]*\}/)?.[0];
    const mobileApp = mobileCss.match(/\.app\s*\{[^}]*\}/)?.[0];

    expect(app).toMatch(/--topbar-height:\s*40px\s*;/);
    expect(mobileApp).toMatch(/--topbar-height:\s*36px\s*;/);
    expect(mobileCss).toMatch(/\.laneTabs\s*\{[^}]*min-height:\s*36px\s*;[^}]*padding:\s*3px\s*;/);
    expect(mobileCss).toMatch(/\.laneTabs\s*\{[^}]*gap:\s*0\s*;/);
    expect(mobileCss).toMatch(/\.laneModelControls\s*\{[^}]*padding-left:\s*0\s*;/);

    // The sliding activation pill covers a tab exactly, with no inner offset.
    const pill = mobileCss.match(/\.laneTabGroup::before\s*\{[^}]*\}/)?.[0];
    expect(pill).toMatch(/top:\s*0\s*;/);
    expect(pill).toMatch(/bottom:\s*0\s*;/);
    expect(pill).toMatch(/left:\s*0\s*;/);
    expect(pill).toMatch(/width:\s*50%\s*;/);
    const mobileGroup = mobileCss.match(/\.laneTabGroup\s*\{[^}]*\}/)?.[0];
    expect(mobileGroup).toMatch(/padding:\s*0\s*;/);
    expect(mobileCss).toMatch(/\.mobileMenuBtn\s*\{[^}]*height:\s*var\(--topbar-height\)\s*;/);
  });

  it("shares the header height with safe-area drawer and overlay positioning", () => {
    const css = readUtf8("../App.css");

    expect(css).toMatch(/\.topbar\s*\{[^}]*height:\s*calc\(var\(--topbar-height\) \+ env\(safe-area-inset-top/);
    expect(css).toMatch(/\.left\.mobileDrawer\s*\{[^}]*top:\s*calc\(var\(--topbar-height\) \+ env\(safe-area-inset-top/);
    expect(css).toMatch(/\.mobileDrawerBackdrop\s*\{[^}]*inset:\s*calc\(var\(--topbar-height\) \+ env\(safe-area-inset-top/);
    expect(css).toMatch(/\.noticeToast\s*\{[^}]*top:\s*calc\(var\(--topbar-height\) \+ env\(safe-area-inset-top/);
    expect(css).not.toMatch(/(?:height|top|inset):\s*calc\(48px \+/);
  });

  it("blends mobile navigation into the chat background without horizontal separators", () => {
    const css = readUtf8("../App.css");
    const mobileCss = css.slice(css.indexOf("@media (max-width: 900px)"));
    const topbar = mobileCss.match(/\.topbar\s*\{[^}]*\}/)?.[0];
    const laneBar = mobileCss.match(/\.laneTabs\s*\{[^}]*\}/)?.[0];

    expect(topbar).toBeDefined();
    expect(topbar).toMatch(/border-bottom:\s*0\s*;/);
    expect(topbar).toMatch(/box-shadow:\s*none\s*;/);
    expect(topbar).toMatch(/background:\s*var\(--app-bg\)\s*;/);

    // The lane bar paints no page-level chrome; the pill surface is the only skin.
    expect(laneBar).toMatch(/border-bottom:\s*none\s*;/);
    expect(laneBar).toMatch(/box-shadow:\s*none\s*;/);
    expect(laneBar).not.toMatch(/background:\s*var\(--app-bg\)\s*;/);
  });

  it("does not render a busy label in the header", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    expect(wrapper.text().toLowerCase()).not.toContain("busy");
    wrapper.unmount();
  });

  it("does not render the legacy empty header container", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    expect(wrapper.find(".header").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the chat detail container flat while busy state remains in the composer", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.detail\s*\{[\s\S]*?position:\s*relative\s*;[\s\S]*?\}/);
    expect(css).not.toContain("detail--active");
    expect(css).not.toMatch(/\.detail\s*\{[^}]*box-shadow\s*:/);
    expect(css).not.toMatch(/\.detail\s*\{[^}]*linear-gradient/);

    const baseProps = {
      queuedPrompts: [],
      pendingImages: [],
      connected: true,
    };

    const idle = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [],
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });
    expect(idle.classes()).not.toContain("detail--active");
    idle.unmount();

    const busy = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [],
        busy: true,
      },
      global: { stubs: { MarkdownContent: true } },
    });
    expect(busy.classes()).not.toContain("detail--active");
    busy.unmount();

    const withHistory = mount(MainChat, {
      props: {
        ...baseProps,
        messages: [{ id: "m-1", role: "user", kind: "text", content: "Hello" }],
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });
    expect(withHistory.classes()).not.toContain("detail--active");
    withHistory.unmount();
  });

  it("uses natural compact padding in the chat stream without a large bottom dead void", () => {
    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.chat\s*\{[\s\S]*?padding:\s*12px 16px\s*;/);
    expect(css).not.toContain("220px");
    expect(css).not.toContain("100px");
  });

  it("renders thread warnings inside the chat pane", () => {
    const warning = "上下文线程已重置（预期=thread-old，实际=thread-new）。";
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        threadWarning: warning,
      },
      global: { stubs: { MarkdownContent: true } },
    });

    const headerWarning = wrapper.find('[data-testid="main-chat-thread-warning"]');
    expect(headerWarning.exists()).toBe(true);
    expect(headerWarning.text()).toContain(warning);
    expect(wrapper.find(".threadWarningBanner").exists()).toBe(true);
    wrapper.unmount();
  });

  it("does not render redundant .paneHeader row in MainChat", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: { stubs: { MarkdownContent: true } },
    });

    expect(wrapper.find(".paneHeader").exists()).toBe(false);
    expect(wrapper.find(".paneTitle").exists()).toBe(false);
    wrapper.unmount();
  });
});
