import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { page } from "vitest/browser";
import AutomationSettings from "../AutomationSettings.svelte";
import { repos } from "#lib/repos.svelte.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import { m } from "#lib/paraglide/messages.js";
let puts: Record<string, unknown>[];
function setup(commit: string | null = "abc123", offline = false) {
  repoConfig.loaded = {};
  repos.loaded = false;
  puts = [];
  const remote = "22222222-2222-4222-8222-222222222222";
  let config = {
    repoMode: "forge",
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    buildQueueEnabled: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    epicStacksEnabled: false,
    autoLabel: "shepherd:auto",
    criticEnabled: true,
    autoMergeEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    maxAuto: 1,
    repoConfigBranch: "trunk",
    repoConfigCommit: commit,
    leitrechner: offline ? remote : null,
    autoDrainEnabled: true,
    fieldSources: { criticEnabled: commit ? "repo" : "rechner" },
    leitrechnerStatus: {
      instanceId: offline ? remote : null,
      name: offline ? "Offline Linux" : null,
      role: offline ? "remote" : "unassigned",
      reachable: offline ? false : null,
      allowed: !offline,
      pauseReason: offline ? "leitrechner_unreachable" : null,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).startsWith("/api/repo-config?")) {
        if (init?.method === "PUT") {
          const patch = JSON.parse(init.body);
          puts.push(patch);
          config = { ...config, ...patch, repoConfigCommit: "saved123" };
        }
        return Response.json(config);
      }
      if (String(url) === "/api/instance")
        return Response.json({
          instanceId: "11111111-1111-4111-8111-111111111111",
          name: "Local Linux",
        });
      if (String(url) === "/api/repos")
        return Response.json({
          repos: [
            {
              path: "/layers-test",
              realPath: "/layers-test",
              name: "layers-test",
              remoteSlug: "owner/repo",
            },
          ],
        });
      if (String(url).startsWith("/api/repo-config/project?"))
        return Response.json({
          machines: [
            {
              instanceId: remote,
              name: "Offline Linux",
              membership: "present",
              reachable: !offline,
              config: null,
            },
          ],
        });
      return new Response("{}", { status: 404 });
    }),
  );
  return render(AutomationSettings, { repoPath: "/layers-test" });
}
afterEach(() => vi.unstubAllGlobals());
it("shows all three levels; stages two rules and confirms one write", async () => {
  setup();
  await expect.element(page.getByText("abc123", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: m.automation_layers_shared(), exact: true }))
    .toBeVisible();
  const critic = page.getByRole("switch", { name: m.automation_critic_name(), exact: true });
  await critic.click();
  await page.getByRole("switch", { name: m.automation_buildqueue_name(), exact: true }).click();
  expect(puts).toEqual([]);
  expect(repoConfig.isEnabled("/layers-test")).toBe(true);
  await page.getByRole("button", { name: m.automation_layers_review(), exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByText("trunk", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: m.automation_layers_save(), exact: true }).click();
  await vi.waitFor(() => expect(puts).toEqual([{ criticEnabled: false, buildQueueEnabled: true }]));
  await expect.element(page.getByText("saved123", { exact: true })).toBeVisible();
});
it("first sharing is explicit even without edits; cancelling creates no commit", async () => {
  setup(null);
  await page.getByRole("button", { name: m.automation_layers_share(), exact: true }).click();
  await page.getByRole("button", { name: m.common_cancel(), exact: true }).click();
  expect(puts).toEqual([]);
});

it("machine limits save immediately while rules stay staged", async () => {
  setup();
  await expect.element(page.getByText("abc123", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: m.automation_critic_name(), exact: true }).click();
  const input = page
    .getByRole("spinbutton", { name: m.drain_cap_label(), exact: true })
    .element() as HTMLInputElement;
  input.value = "4";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(puts).toEqual([{ maxAuto: 4 }]));
  expect(repoConfig.isEnabled("/layers-test")).toBe(true);
  expect(document.querySelectorAll('[data-field="defaultModel"]')).toHaveLength(1);
  expect(
    document
      .querySelector('[data-field="defaultModel"]')
      ?.closest("[data-settings-layer]")
      ?.getAttribute("data-settings-layer"),
  ).toBe("repo");
  expect(
    document
      .querySelector('[data-field="maxAuto"]')
      ?.closest("[data-settings-layer]")
      ?.getAttribute("data-settings-layer"),
  ).toBe("rechner");
});

it("offline ownership pauses visibly and a confirmed takeover joins other rules in one write", async () => {
  setup("abc123", true);
  await expect
    .element(
      page
        .getByRole("region", { name: m.automation_layers_leader(), exact: true })
        .getByRole("status"),
    )
    .toHaveTextContent(m.automation_layers_offline());
  await page
    .getByRole("combobox", { name: m.automation_layers_leader_change(), exact: true })
    .selectOptions("11111111-1111-4111-8111-111111111111");
  await page.getByRole("switch", { name: m.automation_critic_name(), exact: true }).click();
  expect(puts).toEqual([]);
  await page.getByRole("button", { name: m.automation_layers_review(), exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: m.automation_layers_save(), exact: true }).click();
  await vi.waitFor(() =>
    expect(puts).toEqual([
      { leitrechner: "11111111-1111-4111-8111-111111111111", criticEnabled: false },
    ]),
  );
});

it("keeps German confirmation readable on a narrow light viewport", async () => {
  const { overwriteGetLocale } = await import("#lib/paraglide/runtime.js");
  overwriteGetLocale(() => "de");
  document.documentElement.setAttribute("data-theme", "light");
  await page.viewport(390, 844);
  try {
    setup(null, true);
    await page.getByRole("button", { name: m.automation_layers_share(), exact: true }).click();
    const dialog = page.getByRole("dialog").element() as HTMLDialogElement;
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    expect(dialog.scrollTop).toBe(0);
    expect(getComputedStyle(dialog, "::backdrop").backdropFilter).toContain("blur");

    await page.getByRole("button", { name: m.common_cancel(), exact: true }).click();
    expect(puts).toEqual([]);
  } finally {
    overwriteGetLocale(() => "en");
    document.documentElement.removeAttribute("data-theme");
    await page.viewport(1280, 900);
  }
});

it("reopening fetches current rules instead of retaining the indefinitely loaded cache", async () => {
  const mounted = await setup();
  await expect.element(page.getByText("abc123", { exact: true })).toBeVisible();
  await mounted.unmount();
  const updated = {
    ...repoConfig.responses["/layers-test"],
    repoConfigCommit: "elsewhere",
    criticEnabled: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).startsWith("/api/repo-config?")
        ? Response.json(updated)
        : new Response("{}", { status: 404 }),
    ),
  );
  render(AutomationSettings, { repoPath: "/layers-test" });
  await expect.element(page.getByText("elsewhere", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("switch", { name: m.automation_critic_name(), exact: true }))
    .toHaveAttribute("aria-checked", "false");
});
