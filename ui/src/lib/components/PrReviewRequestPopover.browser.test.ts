import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { PrReviewerOptions } from "$lib/api";
import { m } from "$lib/paraglide/messages";

const getPrReviewers = vi.fn();
const requestPrReview = vi.fn();

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getPrReviewers, requestPrReview };
});

const { default: PrReviewRequestPopover } = await import("./PrReviewRequestPopover.svelte");

function options(over: Partial<PrReviewerOptions> = {}): PrReviewerOptions {
  return {
    prNumber: 42,
    repoSlug: "upstream/project",
    isFork: true,
    logins: ["Alice", "bob", "owner"],
    source: "assignees",
    unavailable: false,
    requestedReviewers: ["bob"],
    authorLogin: "OWNER",
    defaultReviewer: "alice",
    isDraft: false,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function opener() {
  const button = document.createElement("button");
  button.textContent = "PR";
  document.body.appendChild(button);
  button.focus();
  return button;
}

const anchor = new DOMRect(24, 30, 70, 20);

beforeEach(() => {
  getPrReviewers.mockReset();
  requestPrReview.mockReset();
  requestPrReview.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PrReviewRequestPopover", () => {
  it("loads eligible people, preselects the configured reviewer, and requests only on submit", async () => {
    getPrReviewers.mockResolvedValue(options());
    const close = vi.fn();
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: close,
      },
    });

    await expect.element(page.getByRole("dialog", { name: m.prreview_title() })).toBeVisible();
    await expect.element(page.getByText("upstream/project", { exact: true })).toBeVisible();
    await expect.element(page.getByText(m.prreview_source_assignees())).toBeVisible();

    const select = page.getByRole("combobox", { name: m.roles_reviewer_label() });
    await expect.element(select).toHaveValue("Alice");
    expect(document.querySelector("option[value='owner']")).toBeNull();
    expect(document.querySelector<HTMLOptionElement>("option[value='bob']")?.disabled).toBe(true);
    expect(document.querySelector("option[value='bob']")?.textContent).toBe(
      m.prreview_already_requested({ login: "bob" }),
    );
    expect(requestPrReview).not.toHaveBeenCalled();

    await select.selectOptions("Alice");
    expect(requestPrReview).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.prreview_title() }).click();

    expect(requestPrReview).toHaveBeenCalledOnce();
    expect(requestPrReview).toHaveBeenCalledWith("session-1", 42, "Alice");
    await expect.element(page.getByText(m.prreview_success({ reviewer: "Alice" }))).toBeVisible();
    expect(document.querySelector<HTMLOptionElement>("option[value='Alice']")?.disabled).toBe(true);
    await expect.element(page.getByRole("button", { name: m.prreview_title() })).toBeDisabled();
  });

  it("does not send twice while a request is pending and keeps success after refresh failure", async () => {
    getPrReviewers.mockResolvedValue(options({ defaultReviewer: "Alice" }));
    const pending = deferred<{ ok: true; refreshPending?: boolean }>();
    requestPrReview.mockReturnValue(pending.promise);
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    const submit = page.getByRole("button", { name: m.prreview_title() });
    await expect.element(submit).toBeEnabled();
    await submit.click();
    document
      .querySelector<HTMLButtonElement>(".actions button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(requestPrReview).toHaveBeenCalledOnce();

    pending.resolve({ ok: true, refreshPending: true });
    await expect
      .element(page.getByText(m.prreview_success_refresh_pending({ reviewer: "Alice" })))
      .toBeVisible();
    await expect.element(submit).toBeDisabled();
  });

  it("keeps every successfully requested reviewer disabled for the popup lifetime", async () => {
    getPrReviewers.mockResolvedValue(
      options({
        logins: ["Alice", "Charlie", "owner"],
        requestedReviewers: [],
        defaultReviewer: "Alice",
      }),
    );
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    const select = page.getByRole("combobox", { name: m.roles_reviewer_label() });
    await page.getByRole("button", { name: m.prreview_title() }).click();
    await select.selectOptions("Charlie");
    await page.getByRole("button", { name: m.prreview_title() }).click();

    expect(requestPrReview).toHaveBeenNthCalledWith(1, "session-1", 42, "Alice");
    expect(requestPrReview).toHaveBeenNthCalledWith(2, "session-1", 42, "Charlie");
    expect(document.querySelector<HTMLOptionElement>("option[value='Alice']")?.disabled).toBe(true);
    expect(document.querySelector<HTMLOptionElement>("option[value='Charlie']")?.disabled).toBe(
      true,
    );
  });

  it("shows draft and unavailable states without enabling submission", async () => {
    getPrReviewers.mockResolvedValue(
      options({ isDraft: true, unavailable: true, logins: [], defaultReviewer: null }),
    );
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    await expect.element(page.getByText(m.prreview_draft())).toBeVisible();
    await expect.element(page.getByText(m.prreview_unavailable())).toBeVisible();
    await expect.element(page.getByRole("button", { name: m.prreview_title() })).toBeDisabled();
    expect(requestPrReview).not.toHaveBeenCalled();
  });

  it("retries a failed load", async () => {
    getPrReviewers.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(options());
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    await expect.element(page.getByRole("alert")).toMatchTextContent(m.prreview_load_failed());
    await page.getByRole("button", { name: m.common_retry() }).click();
    await expect
      .element(page.getByRole("combobox", { name: m.roles_reviewer_label() }))
      .toBeVisible();
    expect(getPrReviewers).toHaveBeenCalledTimes(2);
  });

  it("keeps the PR link available when reviewers fail to load", async () => {
    getPrReviewers.mockRejectedValueOnce(new Error("offline"));
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    await expect.element(page.getByRole("alert")).toMatchTextContent(m.prreview_load_failed());
    await expect
      .element(page.getByRole("link", { name: m.prbadge_open_pr() }))
      .toHaveAttribute("href", "https://github.test/upstream/project/pull/42");
  });

  it("keeps expanded reviewer content inside a narrow viewport", async () => {
    await page.viewport(320, 360);
    getPrReviewers.mockResolvedValue(
      options({
        logins: ["Alice", "bob", "carol", "dave", "erin", "frank", "owner"],
        requestedReviewers: ["bob"],
      }),
    );
    render(PrReviewRequestPopover, {
      props: {
        anchor: new DOMRect(280, 160, 32, 20),
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    const dialog = page.getByRole("dialog", { name: m.prreview_title() });
    await expect
      .element(page.getByRole("combobox", { name: m.roles_reviewer_label() }))
      .toBeVisible();
    const rectOf = () =>
      document.querySelector<HTMLElement>(".review-popover")!.getBoundingClientRect();
    await expect.poll(() => rectOf().bottom).toBeLessThanOrEqual(window.innerHeight - 8);
    const rect = rectOf();
    expect(rect.left).toBeGreaterThanOrEqual(8);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(rect.top).toBeGreaterThanOrEqual(8);
    await expect.element(dialog).toBeVisible();
  });

  it.each([
    ["review_request_forbidden", () => m.prreview_error_forbidden()],
    ["review_request_invalid_reviewer", () => m.prreview_error_invalid_reviewer()],
    ["review_request_stale", () => m.prreview_error_stale()],
    ["review_request_draft", () => m.prreview_draft()],
    ["review_request_failed", () => m.prreview_error_failed()],
    ["review_request_invalid", () => m.prreview_error_invalid()],
    ["review_request_unsupported", () => m.prreview_error_unsupported()],
    ["unexpected", () => m.prreview_error_failed()],
  ])("localizes the %s request failure", async (code, message) => {
    getPrReviewers.mockResolvedValue(options());
    requestPrReview.mockRejectedValueOnce(new Error(code));
    render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: opener(),
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: vi.fn(),
      },
    });

    await page.getByRole("button", { name: m.prreview_title() }).click();
    await expect.element(page.getByRole("alert")).toMatchTextContent(message());
  });

  it("focuses the select and closes on Escape, outside click, or a changed PR", async () => {
    getPrReviewers.mockResolvedValue(options());
    const close = vi.fn();
    const openButton = opener();
    const screen = await render(PrReviewRequestPopover, {
      props: {
        anchor,
        opener: openButton,
        sessionId: "session-1",
        prNumber: 42,
        prUrl: "https://github.test/upstream/project/pull/42",
        onclose: close,
      },
    });

    const select = page.getByRole("combobox", { name: m.roles_reviewer_label() });
    await expect.element(select).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("select")));

    document
      .querySelector<HTMLElement>(".review-popover")!
      .dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(close).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledOnce();

    close.mockClear();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(close).toHaveBeenCalledOnce();

    close.mockClear();
    await screen.rerender({
      anchor,
      opener: openButton,
      sessionId: "session-1",
      prNumber: 43,
      prUrl: "https://github.test/upstream/project/pull/43",
      onclose: close,
    });
    expect(close).toHaveBeenCalledOnce();

    close.mockClear();
    await screen.rerender({
      anchor,
      opener: openButton,
      sessionId: "session-2",
      prNumber: 42,
      prUrl: "https://github.test/upstream/project/pull/42",
      onclose: close,
    });
    expect(close).toHaveBeenCalledOnce();

    await screen.unmount();
    await vi.waitFor(() => expect(document.activeElement).toBe(openButton));
  });
});
