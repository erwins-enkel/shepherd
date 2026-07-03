import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { PluginUpdatesStatus } from "$lib/types";

import PluginUpdatesModal from "./PluginUpdatesModal.svelte";

const status: PluginUpdatesStatus = {
  updateAvailable: true,
  checkedAt: 0,
  plugins: [
    {
      id: "voice",
      name: "Voice Input",
      currentVersion: "1.2.0",
      latestVersion: "1.3.0",
      source: "repository",
      state: "update-available",
    },
    {
      id: "slack",
      name: "Slack Notify",
      currentVersion: "0.4.1",
      latestVersion: "0.4.1",
      source: "git",
      state: "up-to-date",
    },
    {
      id: "copied",
      name: "Copied Plugin",
      currentVersion: "0.1.0",
      latestVersion: null,
      source: "none",
      state: "no-source",
    },
  ],
};

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("PluginUpdatesModal", () => {
  it("lists each plugin with its version and surfaces the updatable one first", () => {
    render(PluginUpdatesModal, { props: { status } });
    const rows = document.querySelectorAll(".plist li");
    expect(rows.length).toBe(3);
    // update-available sorts to the top.
    expect(rows[0]!.querySelector(".pname")!.textContent).toBe("Voice Input");
    expect(rows[0]!.querySelector(".badge.update-available")).not.toBeNull();
    // A plugin with no resolvable source is shown, not hidden.
    expect(document.body.textContent).toContain("Copied Plugin");
  });

  it("calls onclose when the close button is clicked", () => {
    const onclose = vi.fn();
    render(PluginUpdatesModal, { props: { status, onclose } });
    document.querySelector<HTMLButtonElement>(".later")?.click();
    expect(onclose).toHaveBeenCalled();
  });

  it("renders an empty state with no plugins", () => {
    render(PluginUpdatesModal, {
      props: { status: { plugins: [], updateAvailable: false, checkedAt: 0 } },
    });
    expect(document.querySelector(".empty")).not.toBeNull();
    expect(document.querySelector(".plist")).toBeNull();
  });
});
