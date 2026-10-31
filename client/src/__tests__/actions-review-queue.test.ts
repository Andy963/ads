import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import ActionsReviewQueue from "../components/ActionsReviewQueue.vue";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Actions Reviewer queue", () => {
  it("renders one compact card and refreshes active jobs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          id: "review-job",
          job_kind: "pull_request_review",
          issue_title: "Review the queue migration",
          status: "verifying",
          current_step: "Running checks",
          pr_number: 598,
          pr_url: "https://github.invalid/pull/598",
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          id: "review-job",
          job_kind: "pull_request_review",
          issue_title: "Review the queue migration",
          status: "completed",
          current_step: "PASS: Queue behavior is correct",
          pr_number: 598,
          pr_url: "https://github.invalid/pull/598",
        }],
      });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ActionsReviewQueue, { props: { projectId: "project-1" } });
    await flushPromises();
    expect(wrapper.text()).toContain("PR #598");
    expect(wrapper.text()).toContain("VERIFYING");
    expect(wrapper.text()).toContain("Review the queue migration");
    expect(wrapper.findAll('[data-testid="actions-review-card"]')).toHaveLength(1);
    expect(wrapper.text()).not.toContain("Running checks");

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/actions/jobs?projectId=project-1", { credentials: "include" });
    expect(wrapper.find('[data-testid="actions-review-card"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Queue behavior is correct");
    expect(wrapper.text()).not.toContain("npm test");
    wrapper.unmount();
  });

  it("loads the queue when the Actions lane becomes active", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: "review-job",
        job_kind: "pull_request_review",
        issue_title: "Review the queue migration",
        status: "completed",
        current_step: "PASS: Reviewed",
        pr_number: 598,
        pr_url: "https://github.invalid/pull/598",
      }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ActionsReviewQueue, { props: { projectId: "project-1", active: false } });
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="actions-review-card"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
