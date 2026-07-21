import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { CodexReleaseNotesResult, CodexUpdateStatus } from "$lib/types";
import { m } from "$lib/paraglide/messages";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyCodexUpdate: vi.fn(() => new Promise(() => {})),
}));

import CodexUpdateModal from "./CodexUpdateModal.svelte";

const update: CodexUpdateStatus = {
  current: "0.142.4",
  latest: "0.142.5",
  updateAvailable: true,
  notes: null,
  checkedAt: 0,
};

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("CodexUpdateModal", () => {
  it("loads notes exactly once while keeping localized pending/incomplete states and controls usable", async () => {
    let resolveNotes!: (result: CodexReleaseNotesResult) => void;
    const pending = new Promise<CodexReleaseNotesResult>((resolve) => {
      resolveNotes = resolve;
    });
    const loadReleaseNotes = vi.fn(() => pending);
    const onclose = vi.fn();
    const { rerender } = await render(CodexUpdateModal, {
      props: { update, loadReleaseNotes, onclose },
    });

    await expect.element(page.getByText(m.codexupdate_notes_loading())).toBeVisible();
    expect(loadReleaseNotes).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>(".run")?.disabled).toBe(false);
    document.querySelector<HTMLButtonElement>(".later")?.click();
    expect(onclose).toHaveBeenCalledOnce();

    await rerender({
      update: { ...update, checkedAt: 1 },
      loadReleaseNotes,
      onclose,
    });
    expect(loadReleaseNotes).toHaveBeenCalledTimes(1);

    resolveNotes({
      current: update.current,
      latest: update.latest,
      notes: [{ version: "0.142.5", body: "Original **release body**" }],
      complete: false,
    });
    await expect.element(page.getByText(m.codexupdate_notes_incomplete())).toBeVisible();
    await expect.element(page.getByText("release body")).toBeVisible();
    expect(document.querySelector<HTMLButtonElement>(".run")?.disabled).toBe(false);
  });

  it("turns a notes request rejection into the visible fallback without disabling update actions", async () => {
    const loadReleaseNotes = vi.fn(async () => {
      throw new Error("offline");
    });
    await render(CodexUpdateModal, { props: { update, loadReleaseNotes } });

    await expect.element(page.getByText(m.codexupdate_notes_incomplete())).toBeVisible();
    expect(document.querySelector<HTMLButtonElement>(".run")?.disabled).toBe(false);
    expect(document.querySelector(".all-notes")).not.toBeNull();
  });

  it("ends the pending state at the fixed deadline even when the loader ignores abort", async () => {
    const capturedSignals: AbortSignal[] = [];
    const loadReleaseNotes = vi.fn((signal: AbortSignal) => {
      capturedSignals.push(signal);
      return new Promise<CodexReleaseNotesResult>(() => {});
    });
    await render(CodexUpdateModal, {
      props: { update, loadReleaseNotes, notesTimeoutMs: 1 },
    });

    await expect.element(page.getByText(m.codexupdate_notes_incomplete())).toBeVisible();
    expect(capturedSignals[0]?.aborted).toBe(true);
    expect(loadReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("hides a late range-A result after status moves to B without refetching", async () => {
    let resolveNotes!: (result: CodexReleaseNotesResult) => void;
    const loadReleaseNotes = vi.fn(
      () =>
        new Promise<CodexReleaseNotesResult>((resolve) => {
          resolveNotes = resolve;
        }),
    );
    const { rerender } = await render(CodexUpdateModal, {
      props: { update, loadReleaseNotes },
    });
    const rangeB = {
      ...update,
      current: "0.142.5",
      latest: "0.142.6",
      checkedAt: 2,
    };
    await rerender({ update: rangeB, loadReleaseNotes });
    resolveNotes({
      current: update.current,
      latest: update.latest,
      notes: [{ version: "0.142.5", body: "stale range A body" }],
      complete: true,
    });

    await vi.waitFor(() => expect(loadReleaseNotes).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain("stale range A body");
  });

  it("keeps modal chrome from creating stray scrollbars with an active update log", async () => {
    await page.viewport(800, 600);

    render(CodexUpdateModal, {
      props: {
        update,
        loadReleaseNotes: async () => ({
          current: update.current,
          latest: update.latest,
          notes: [{ version: "0.142.5", body: "Long release detail\n\n".repeat(80) }],
          complete: true,
        }),
        log: [
          "=== codex-update 2026-07-01T07:10:00Z 0.142.4 -> 0.142.5 ===",
          ">>> codex-update: running codex update",
          "Updating Codex via `npm install -g @openai/codex`...",
          "changed 2 packages in 5s",
          ">>> codex-update: codex update exited rc=0",
        ],
      },
    });

    await expect.element(page.getByText("Long release detail").first()).toBeVisible();
    const history = document.querySelector<HTMLElement>(".release-history");
    expect(history).not.toBeNull();
    expect(history!.scrollHeight).toBeGreaterThan(history!.clientHeight);
    const actions = document.querySelector<HTMLElement>(".actions");
    const cardBeforeUpdate = document.querySelector<HTMLElement>(".card");
    expect(actions!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      cardBeforeUpdate!.getBoundingClientRect().bottom,
    );

    document.querySelector<HTMLButtonElement>(".run")?.click();
    await vi.waitFor(() => expect(document.querySelector(".log")).not.toBeNull());

    const card = document.querySelector<HTMLElement>(".card");
    expect(card).not.toBeNull();
    expect(card!.scrollWidth, "dialog should not have horizontal overflow").toBeLessThanOrEqual(
      card!.clientWidth,
    );
    expect(
      card!.scrollHeight,
      "dialog should not need its own vertical scrollbar",
    ).toBeLessThanOrEqual(card!.clientHeight + 1);
  });

  it("shows the stuck-update message naming the on-PATH binary on non-convergence", async () => {
    const props = { update, log: [">>> codex-update: codex update exited rc=0"] };
    const { rerender } = await render(CodexUpdateModal, { props });

    // click Run so the modal enters its submitting state, then deliver a
    // non-converged `done` that carries the on-PATH binary (as the server would).
    document.querySelector<HTMLButtonElement>(".run")?.click();
    await rerender({
      ...props,
      done: {
        ok: false,
        from: "0.142.4",
        to: "0.142.4",
        onPathBinary: "/home/op/.local/bin/codex",
      },
    });

    await vi.waitFor(() =>
      expect(document.querySelector(".status.fail")?.textContent ?? "").toContain(
        "/home/op/.local/bin/codex",
      ),
    );
  });

  it("keeps the completed update's actual version transition after status refreshes", async () => {
    const { rerender } = await render(CodexUpdateModal, { props: { update } });

    await rerender({
      update: { ...update, current: "0.142.5", latest: "0.142.5", updateAvailable: false },
      done: { ok: true, from: "0.142.4", to: "0.142.5" },
    });

    await vi.waitFor(() =>
      expect(document.querySelector(".versions")?.textContent).toContain("0.142.4 → 0.142.5"),
    );
  });
});
