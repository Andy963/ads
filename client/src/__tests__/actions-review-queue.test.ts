import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import ActionsReviewQueue from "../components/ActionsReviewQueue.vue";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Actions Reviewer queue", () => {
  it("renders pinned review results and refreshes active jobs", async () => {
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
          branch: "codex/issue-598",
          base_sha: "base-commit-1234567890",
          head_sha: "head-commit-1234567890",
          pr_number: 598,
          pr_url: "https://github.invalid/pull/598",
          error_message: null,
          verification_report_json: "",
          review_verdicts_json: "[]",
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
          branch: "codex/issue-598",
          base_sha: "base-commit-1234567890",
          head_sha: "head-commit-1234567890",
          pr_number: 598,
          pr_url: "https://github.invalid/pull/598",
          error_message: null,
          verification_report_json: JSON.stringify({
            command: "npm test",
            exitCode: 0,
            summary: "All tests passed",
          }),
          review_verdicts_json: JSON.stringify([{
            status: "PASS",
            summary: "Queue behavior is correct",
            defects: [],
          }]),
        }],
      });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ActionsReviewQueue, { props: { projectId: "project-1" } });
    await flushPromises();
    expect(wrapper.text()).toContain("PR #598");
    expect(wrapper.text()).toContain("Running checks");

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/actions/jobs?projectId=project-1", { credentials: "include" });
    expect(wrapper.text()).toContain("PASS");
    expect(wrapper.text()).toContain("Queue behavior is correct");
    expect(wrapper.text()).toContain("npm test (exit 0)");
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
        branch: "codex/issue-598",
        base_sha: "base-commit-1234567890",
        head_sha: "head-commit-1234567890",
        pr_number: 598,
        pr_url: "https://github.invalid/pull/598",
        error_message: null,
        verification_report_json: "",
        review_verdicts_json: JSON.stringify([{ status: "PASS", summary: "Reviewed", defects: [] }]),
      }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ActionsReviewQueue, { props: { projectId: "project-1", active: false } });
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("PASS");
    wrapper.unmount();
  });
});
