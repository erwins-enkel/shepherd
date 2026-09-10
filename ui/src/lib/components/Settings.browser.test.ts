import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { Settings as SettingsPayload, DiagnosticCheck } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import {
  getSettings,
  verifyApiKey,
  putAnthropicApiKey,
  putDefaultCodexModel,
  putDefaultModel,
  fixDiagnostic,
  putRoleEffort,
  putDefaultEffort,
} from "$lib/api";
import { toasts } from "$lib/toasts.svelte";
import { roleTitle } from "$lib/settings-search";
import { issueRef } from "$lib/issue-ref.svelte";

// Mock the API so Settings never hits the network. The settings GET is seeded to
// land on api-key mode WITH a key configured, so the api-key block + Verify button
// render; each test then drives verifyApiKey / putAnthropicApiKey.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getSettings: vi.fn(),
    putRoleCli: vi.fn(async (key, value) => ({ [key]: value })),
    putRoleModel: vi.fn(async (key, value) => ({ [key]: value })),
    putRoleEffort: vi.fn(async (key, value) => ({ [key]: value })),
    putDefaultEffort: vi.fn(async (value) => ({ defaultEffort: value })),
    listDirs: vi.fn(async () => ({ path: "/repo", display: "/repo", parent: null, entries: [] })),
    getSteers: vi.fn(async () => []),
    getCommands: vi.fn(async () => ({ commands: [] })),
    getDiagnostics: vi.fn(async () => ({ checks: [] })),
    fixDiagnostic: vi.fn(),
    verifyApiKey: vi.fn(),
    putAnthropicApiKey: vi.fn(),
    putAuthMode: vi.fn(async () => ({ authMode: "api-key", hasApiKey: true })),
    putDefaultAgentProvider: vi.fn(async (provider) => ({ defaultAgentProvider: provider })),
    putDefaultModel: vi.fn(async (model) => ({ defaultModel: model })),
    putDefaultCodexModel: vi.fn(async (model) => ({ defaultCodexModel: model })),
  };
});

// `onMount` awaits refreshPush() before loading settings; a throwing push probe
// would abort the load and never render the api-key block. Stub it to a quiet,
// unsupported, unsubscribed state.
vi.mock("$lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/push")>();
  return {
    ...actual,
    pushState: vi.fn(async () => ({
      supported: false,
      permission: "unsupported" as const,
      subscribed: false,
    })),
    getPushCategories: vi.fn(async () => ({ agent: true, reviews: true, ci: true })),
  };
});

const { default: Settings } = await import("./Settings.svelte");

const mockGetSettings = vi.mocked(getSettings);
const mockVerify = vi.mocked(verifyApiKey);
const mockPutKey = vi.mocked(putAnthropicApiKey);
const mockPutCodexModel = vi.mocked(putDefaultCodexModel);
const mockPutModel = vi.mocked(putDefaultModel);
const mockFix = vi.mocked(fixDiagnostic);

function settings(over: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    repoRoot: "/repo",
    repoRootDisplay: "/repo",
    firstRunPending: false,
    remoteControlAtStartup: false,
    envTokenActive: false,
    sessionHousekeepingEnabled: true,
    autoReviveEnabled: false,
    defaultModel: "auto",
    defaultCodexModel: "gpt-5.5",
    defaultEffort: "default",
    operatorLanguage: "en",
    criticCli: "inherit",
    criticModel: "default",
    criticEffort: "high",
    plannerCli: "inherit",
    plannerModel: "default",
    plannerEffort: "default",
    recapCli: "claude",
    recapModel: "sonnet",
    recapEffort: "low",
    docAgentCli: "inherit",
    docAgentModel: "default",
    docAgentEffort: "low",
    namerCli: "claude",
    namerModel: "haiku",
    namerEffort: "low",
    autopilotCli: "claude",
    autopilotModel: "haiku",
    autopilotEffort: "low",
    defaultAgentProvider: "claude",
    upnextSkipCliPicker: false,
    authMode: "api-key",
    hasApiKey: true,
    prReviewCyclesCap: 3,
    prReviewCyclesMin: 1,
    prReviewCyclesMax: 8,
    planReviewCyclesCap: 5,
    planReviewCyclesMin: 1,
    planReviewCyclesMax: 12,
    extraCreditsDrainCeiling: 0,
    sessionRetentionDays: 30,
    sessionRetentionKeep: 250,
    previewHost: null,
    usageHoldEnabled: true,
    usageHoldPct: 90,
    usageHoldAutoRelease: true,
    usageDowngradeEnabled: false,
    usageDowngradePct: 80,
    usageDowngradeModel: "haiku",
    fableAvailable: true,
    tuiFullscreen: false,
    tuiDisableMouse: false,
    reducedPushMode: false,
    telemetryConsent: "unset",
    telemetryAvailable: true,
    docAgentEnabled: false,
    docAgentAct: true,
    ...over,
  };
}

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --font-mono: ui-monospace, monospace;
    --color-panel: #1a1a1a;
    --color-line: #333;
    --color-line-bright: #555;
    --color-inset: #111;
    --color-ink: #ccc;
    --color-ink-bright: #fff;
    --color-muted: #666;
    --color-faint: #444;
    --color-amber: #f5a623;
    --color-green: #4caf50;
    --color-red: #f44336;
    --color-blue: #2196f3;
    --color-scrim: rgba(0,0,0,0.6);
    --fs-base: 13px;
    --fs-meta: 12px;
    --fs-micro: 10px;
    --fs-lg: 15px;
    --fs-xl: 18px;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }`;
  document.head.appendChild(fontStyle);
  mockGetSettings.mockReset();
  mockVerify.mockReset();
  mockPutKey.mockReset();
  mockPutCodexModel.mockReset();
  mockPutCodexModel.mockImplementation(async (model) => ({ defaultCodexModel: model }));
  mockPutModel.mockReset();
  mockPutModel.mockImplementation(async (model) => ({ defaultModel: model }));
  // Default seed: api-key mode, key configured → Verify button renders.
  mockGetSettings.mockResolvedValue(settings());
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

const noop = () => {};

const verifyBtn = () => page.getByRole("button", { name: m.settings_auth_key_verify() });
const saveBtn = () => page.getByRole("button", { name: m.settings_auth_key_save(), exact: true });
const keyInput = () => page.getByRole("textbox", { name: m.settings_auth_key_label() });

async function mountCodingAgents() {
  // The default vitest-browser viewport is narrow → the mobile section LIST
  // would show and the pane (with every panel) would be hidden. These suites
  // exercise the desktop pane, so pin a desktop viewport first.
  await page.viewport(1280, 900);
  return render(Settings, { initialTab: "codingAgents", onclose: noop, onsaved: noop });
}

async function mountClaudeApiKeySettings() {
  await mountCodingAgents();
  const { disclosure, button } = requiredCodingSectionButton(m.settings_cli_claude_title());
  if (button.getAttribute("aria-expanded") === "false") {
    await disclosure.click();
  }
}

// The redesigned Coding CLI section (handoff 5a): GLOBAL DEFAULTS is a static,
// always-visible group; the per-CLI groups (Claude Code, Codex, Agent
// environments) are collapsed rows that expand in place.
const codingGroupNames = () => [
  m.settings_cli_claude_title(),
  m.settings_cli_codex_title(),
  m.settings_role_models_title(),
];

function codingSectionButton(name: string) {
  return page.getByRole("button", { name, exact: true });
}

function requiredCodingSectionButton(name: string) {
  const disclosure = codingSectionButton(name);
  const button = disclosure.query() as HTMLButtonElement | null;
  expect(button, `missing Coding CLI group button named "${name}"`).not.toBeNull();
  return { disclosure, button: button! };
}

function controlledSection(button: HTMLElement): HTMLElement {
  const id = button.getAttribute("aria-controls");
  expect(id, "disclosure has aria-controls").toBeTruthy();
  const content = document.getElementById(id!);
  expect(content, `controlled content #${id} stays mounted`).not.toBeNull();
  return content!;
}

function expectInitialCodingSectionState() {
  for (const name of codingGroupNames()) {
    const { button } = requiredCodingSectionButton(name);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(controlledSection(button).hidden).toBe(true);
  }
}

describe("Settings Coding CLI sections", () => {
  it("renders GLOBAL DEFAULTS open with the three collapsed groups in order", async () => {
    await mountCodingAgents();

    // The GLOBAL DEFAULTS rows are always visible — no disclosure gate.
    await expect
      .element(page.getByRole("combobox", { name: m.settings_default_agent_provider_title() }))
      .toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: m.settings_upnext_skip_cli_picker_label() }))
      .toBeVisible();

    const buttons: HTMLElement[] = [];
    for (const name of codingGroupNames()) {
      buttons.push(requiredCodingSectionButton(name).button);
    }
    for (let index = 0; index < buttons.length - 1; index += 1) {
      expect(
        buttons[index].compareDocumentPosition(buttons[index + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    for (const button of buttons) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(controlledSection(button).hidden).toBe(true);
    }
  });

  it("click toggles a collapsed group without replacing its controlled content", async () => {
    await mountCodingAgents();
    const { disclosure, button } = requiredCodingSectionButton(m.settings_cli_claude_title());
    const content = controlledSection(button);
    expect(content.hidden).toBe(true);

    await disclosure.click();
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(content.id)).toBe(content);
    expect(content.hidden).toBe(false);

    const defaultEffortSelect = page
      .getByRole("combobox", { name: m.settings_default_effort_title() })
      .element();
    expect(content.contains(defaultEffortSelect)).toBe(true);

    await disclosure.click();
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(content.id)).toBe(content);
    expect(content.hidden).toBe(true);
    expect(content.contains(defaultEffortSelect)).toBe(true);

    await disclosure.click();
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(content.id)).toBe(content);
    expect(content.hidden).toBe(false);
    expect(page.getByRole("combobox", { name: m.settings_default_effort_title() }).element()).toBe(
      defaultEffortSelect,
    );
  });

  it("native Enter and Space button interaction toggles a focused disclosure", async () => {
    await mountCodingAgents();
    const { button } = requiredCodingSectionButton(m.settings_cli_codex_title());
    button.focus();
    expect(document.activeElement).toBe(button);

    await userEvent.keyboard("{Enter}");
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard(" ");
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves an expanded group while switching Settings sections", async () => {
    await page.viewport(1280, 900);
    await mountCodingAgents();
    const { disclosure, button } = requiredCodingSectionButton(m.settings_role_models_title());
    await disclosure.click();
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");

    await page.getByRole("tab", { name: m.settings_tab_session() }).click();
    await page.getByRole("tab", { name: m.settings_tab_coding_agents() }).click();

    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
    expect(controlledSection(button).hidden).toBe(false);
  });

  it("resets to all groups collapsed after Settings is remounted", async () => {
    const first = await mountCodingAgents();
    const { disclosure, button } = requiredCodingSectionButton(m.settings_cli_codex_title());
    await disclosure.click();
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");

    await first.unmount();
    await mountCodingAgents();

    expectInitialCodingSectionState();
  });
});

describe("Settings default coding environment", () => {
  it("shows the saved Recap CLI, model, and effort", async () => {
    await mountCodingAgents();
    const { disclosure } = requiredCodingSectionButton(m.settings_role_models_title());
    await disclosure.click();

    const role = "Recap";
    await expect.element(page.getByText(role, { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: m.settings_role_cli_label({ role }) }))
      .toHaveValue("claude");
    await expect
      .element(page.getByRole("combobox", { name: m.settings_role_model_label({ role }) }))
      .toHaveValue("sonnet");
    await expect
      .element(page.getByRole("combobox", { name: m.settings_role_effort_label({ role }) }))
      .toHaveValue("low");
  });

  it("loads the saved model for the selected Codex CLI", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ defaultAgentProvider: "codex", defaultCodexModel: "gpt-5.4" }),
    );
    await mountCodingAgents();

    const model = page.getByTestId("default-environment-model");
    await expect.element(model).toHaveValue("gpt-5.4");
  });

  it("switching CLI restores each CLI's saved model", async () => {
    mockGetSettings.mockResolvedValue(
      settings({
        defaultAgentProvider: "claude",
        defaultModel: "opus",
        defaultCodexModel: "gpt-5.4",
      }),
    );
    await mountCodingAgents();

    const provider = page.getByRole("combobox", {
      name: m.settings_default_agent_provider_title(),
    });
    const model = page.getByTestId("default-environment-model");
    await expect.element(model).toHaveValue("opus");
    await provider.selectOptions("codex");
    await expect.element(model).toHaveValue("gpt-5.4");
    await provider.selectOptions("claude");
    await expect.element(model).toHaveValue("opus");
  });

  it("saves Codex model changes through the Codex preference endpoint", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ defaultAgentProvider: "codex", defaultCodexModel: "gpt-5.4" }),
    );
    await mountCodingAgents();

    const model = page.getByTestId("default-environment-model");
    await model.selectOptions("gpt-5.6-luna");

    await vi.waitFor(() => expect(mockPutCodexModel).toHaveBeenCalledWith("gpt-5.6-luna"));
  });

  it("reverts a Codex model change when saving fails", async () => {
    toasts.items = [];
    mockGetSettings.mockResolvedValue(
      settings({ defaultAgentProvider: "codex", defaultCodexModel: "gpt-5.4" }),
    );
    mockPutCodexModel.mockRejectedValue(new Error("save failed"));
    await mountCodingAgents();

    const model = page.getByTestId("default-environment-model");
    await model.selectOptions("gpt-5.6-luna");

    await expect.element(model).toHaveValue("gpt-5.4");
    await vi.waitFor(() =>
      expect(
        toasts.items.some((toast) => toast.text === m.settings_default_codex_model_save_failed()),
      ).toBe(true),
    );
  });

  // The role "Effective:" line states what the role WILL run on, so it must use the
  // configured label ("Opus (latest)") and match the picker above it — not the record
  // label a session card shows. Reverting resolvedRoleEnv() to modelLabel() renders a
  // bare "opus" here and fails this.
  //
  // Three preconditions, each of which would otherwise make this vacuous or wrong:
  //  - seed a CONCRETE defaultModel: the shared fixture uses "auto", which takes the
  //    provider-default branch and never reaches the model label at all;
  //  - compose the provider half from settings_cli_claude() — the panel's own
  //    providerLabel() uses it, not agent_provider_claude() (identical text today, so
  //    the wrong key would pass while pinning a key this panel never calls);
  //  - scope to ONE role row: every inherit-CLI role renders identical text, so a bare
  //    getByText matches several. Anchoring on the row's per-role CLI combobox pins the
  //    assertion to a role rather than to DOM order (which an nth/first would).
  it("shows a role's effective environment with the configured model label", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ defaultAgentProvider: "claude", defaultModel: "opus", criticCli: "inherit" }),
    );
    await mountCodingAgents();

    const { disclosure, button } = requiredCodingSectionButton(m.settings_role_models_title());
    if (button.getAttribute("aria-expanded") === "false") await disclosure.click();

    const cli = page.getByRole("combobox", {
      name: m.settings_role_cli_label({ role: roleTitle("critic") }),
    });
    await expect.element(cli).toHaveValue("inherit");

    const row = (cli.query() as HTMLElement | null)?.closest(".rrow");
    expect(row, "critic role row").not.toBeNull();
    expect(row!.textContent).toContain(
      m.settings_role_model_effective({
        model: `${m.settings_cli_claude()} · ${m.model_configured_opus_latest()}`,
      }),
    );
  });

  // #2240: a settings PUT that answers 200 WITHOUT the field it owns must not poison the local
  // value. `defaultModel = undefined` throws inside SettingsCodingCliPanel's `is1mModel`
  // ($derived(defaultModel.endsWith("[1m]"))) during Svelte's flush; that abandons the batch, so
  // every effect not yet processed stays dirty forever and the whole dialog stops reacting until a
  // page reload. The visible tell was a role's guidance line frozen on the global default's copy
  // while its own "Effective:" line kept tracking — so this asserts on the guidance line.
  //
  // Both halves matter: without the toHaveValue check the role pickers could be inert for an
  // unrelated reason, and without the not.toContain the assertion would pass on a guidance line
  // that merely happens to mention several models.
  it("a settings PUT that omits its own field leaves the dialog reactive", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ defaultAgentProvider: "claude", defaultModel: "opus", plannerCli: "inherit" }),
    );
    // Exactly what the demo router used to answer for every unhandled settings mutation.
    mockPutModel.mockResolvedValue({} as { defaultModel: string });
    await mountCodingAgents();

    const { disclosure, button } = requiredCodingSectionButton(m.settings_role_models_title());
    if (button.getAttribute("aria-expanded") === "false") await disclosure.click();

    await page.getByTestId("default-environment-model").selectOptions("sonnet");
    await vi.waitFor(() => expect(mockPutModel).toHaveBeenCalledWith("sonnet"));

    const cli = page.getByRole("combobox", {
      name: m.settings_role_cli_label({ role: roleTitle("planner") }),
    });
    await cli.selectOptions("codex");
    const roleModel = page.getByRole("combobox", {
      name: m.settings_role_model_label({ role: roleTitle("planner") }),
    });
    await roleModel.selectOptions("gpt-6-astra");
    await expect.element(roleModel).toHaveValue("gpt-6-astra");

    const row = (cli.query() as HTMLElement | null)?.closest(".rrow");
    expect(row, "planner role row").not.toBeNull();
    await vi.waitFor(() => {
      const guidance = row!.querySelector(".model-guidance");
      expect(guidance?.textContent).toContain(m.model_guidance_codex_6_astra());
    });
    // The frozen line reported in #2240 was the GLOBAL default's guidance.
    expect(row!.querySelector(".model-guidance")!.textContent).not.toContain(
      m.model_guidance_claude_opus(),
    );
  });
});

describe("Settings api-key verify", () => {
  it("verify → OK renders the verified line", async () => {
    mockVerify.mockResolvedValue({ ok: true });
    await mountClaudeApiKeySettings();

    await expect.element(verifyBtn()).toBeInTheDocument();
    await verifyBtn().click();

    await expect.element(page.getByText(m.settings_auth_key_verify_ok())).toBeInTheDocument();
  });

  it("verify → failed surfaces the not-authenticated message AND the verbatim detail", async () => {
    mockVerify.mockResolvedValue({
      ok: false,
      reason: "not-authenticated",
      detail: "invalid x-api-key",
    });
    await mountClaudeApiKeySettings();

    await expect.element(verifyBtn()).toBeInTheDocument();
    await verifyBtn().click();

    // The failed line prefixes the failure header, then the resolved not-authenticated
    // message, then the verbatim server detail (surfaced as data, not translated).
    await expect
      .element(page.getByText(m.settings_auth_key_verify_not_authenticated(), { exact: false }))
      .toBeInTheDocument();
    await expect.element(page.getByText("invalid x-api-key", { exact: false })).toBeInTheDocument();
    // Not the OK state.
    await expect.element(page.getByText(m.settings_auth_key_verify_ok())).not.toBeInTheDocument();
  });

  it("verify throw → fail-closed (renders FAILED, never OK)", async () => {
    mockVerify.mockRejectedValue(new Error("boom"));
    await mountClaudeApiKeySettings();

    await expect.element(verifyBtn()).toBeInTheDocument();
    await verifyBtn().click();

    // A thrown probe must read as a failure, not silently pass.
    await expect
      .element(page.getByText(m.settings_auth_key_verify_error_generic(), { exact: false }))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.settings_auth_key_verify_ok())).not.toBeInTheDocument();
  });

  it("saving a key auto-verifies it (the key gap) and renders the verdict", async () => {
    // Start with NO key so the Save flow is the thing under test.
    mockGetSettings.mockResolvedValue(settings({ hasApiKey: false }));
    mockPutKey.mockResolvedValue({ hasApiKey: true });
    mockVerify.mockResolvedValue({ ok: true });
    await mountClaudeApiKeySettings();

    await expect.element(keyInput()).toBeInTheDocument();
    await keyInput().fill("sk-ant-test");
    await saveBtn().click();

    // Auto-verify must have fired off the back of a successful save…
    await vi.waitFor(() => expect(mockVerify).toHaveBeenCalled());
    // …and its verdict renders inline.
    await expect.element(page.getByText(m.settings_auth_key_verify_ok())).toBeInTheDocument();
  });
});

// The 5b mobile layout: the tab strip / dropdown is gone. A plain open lands on
// a full-screen section LIST; tapping a row drills into that section's detail
// page (a labelled region — no tablist exists on mobile); ‹ goes back. Desktop
// keeps the tab pattern on the nav rail.
describe("Settings responsive navigation", () => {
  const onePlugin = [
    {
      id: "p1",
      name: "Demo",
      version: "1.0.0",
      health: "ok" as const,
      lastError: null,
      status: {},
      ui: null,
      gearItem: null,
    },
  ];

  afterEach(async () => {
    await page.viewport(1280, 900); // restore a sane width for other suites
  });

  it("narrow viewport → section list, drill-in detail, and back", async () => {
    await page.viewport(360, 900); // ≤768px → mobile sheet
    render(Settings, { plugins: onePlugin, onclose: noop, onsaved: noop });

    // List mode: section rows render as buttons (no tab roles, no panel region).
    const pluginsRow = page.getByRole("button", { name: m.settings_tab_plugins(), exact: false });
    await expect.element(pluginsRow).toBeVisible();
    await expect
      .element(page.getByRole("tab", { name: m.settings_tab_plugins() }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("region", { name: m.settings_tab_workspace() }))
      .not.toBeInTheDocument();

    // Drill in: the Plugins detail page is a labelled region; the list is gone.
    await pluginsRow.click();
    await expect
      .element(page.getByRole("region", { name: m.settings_tab_plugins() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.settings_tab_device(), exact: false }))
      .not.toBeInTheDocument();

    // Back returns to the list.
    await page.getByRole("button", { name: m.settings_back_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.settings_tab_device(), exact: false }))
      .toBeVisible();
  });

  it("narrow viewport → a deep link drills straight into the section detail", async () => {
    await page.viewport(360, 900);
    render(Settings, {
      initialTab: "plugins",
      initialMobileView: "detail",
      plugins: onePlugin,
      onclose: noop,
      onsaved: noop,
    });

    await expect
      .element(page.getByRole("region", { name: m.settings_tab_plugins() }))
      .toBeInTheDocument();
  });

  it("desktop viewport → Plugins renders as a rail tab and the panel is a tabpanel", async () => {
    await page.viewport(1280, 900); // >768px → nav rail with tab semantics
    render(Settings, { plugins: onePlugin, onclose: noop, onsaved: noop });

    await expect
      .element(page.getByRole("tab", { name: m.settings_tab_plugins() }))
      .toBeInTheDocument();
    // The active panel carries the tab pattern's tabpanel role on desktop.
    await expect
      .element(page.getByRole("tabpanel", { name: m.settings_tab_workspace() }))
      .toBeInTheDocument();
  });

  it("renders Steers between Coding CLI and Plugins in its own panel", async () => {
    await page.viewport(1280, 900);
    render(Settings, { initialTab: "steers", onclose: noop, onsaved: noop });

    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    const labels = tabs.map((tab) => tab.querySelector(".ilabel")?.textContent?.trim());
    expect(labels.indexOf(m.settings_tab_steers())).toBe(
      labels.indexOf(m.settings_tab_coding_agents()) + 1,
    );
    expect(labels.indexOf(m.settings_tab_plugins())).toBe(
      labels.indexOf(m.settings_tab_steers()) + 1,
    );

    const steersPanel = document.querySelector<HTMLElement>("#settings-panel-steers");
    const sessionPanel = document.querySelector<HTMLElement>("#settings-panel-session");
    expect(steersPanel?.getAttribute("role")).toBe("tabpanel");
    expect(steersPanel?.querySelector(".editor")).not.toBeNull();
    expect(sessionPanel?.querySelector(".editor")).toBeNull();
  });
});

describe("Settings dialog layout stability", () => {
  afterEach(async () => {
    await page.viewport(1280, 900);
  });

  function cardMetrics() {
    const card = document.querySelector<HTMLElement>(".card");
    expect(card).not.toBeNull();
    const rect = card!.getBoundingClientRect();
    return {
      top: rect.top,
      height: rect.height,
      computedHeight: getComputedStyle(card!).height,
    };
  }

  it("desktop section switches keep the modal shell stable", async () => {
    await page.viewport(1280, 900);
    render(Settings, { onclose: noop, onsaved: noop });

    await expect
      .element(page.getByRole("tabpanel", { name: m.settings_tab_workspace() }))
      .toBeInTheDocument();
    const before = cardMetrics();

    await page.getByRole("tab", { name: m.settings_tab_session() }).click();
    await expect
      .element(page.getByRole("tabpanel", { name: m.settings_tab_session() }))
      .toBeInTheDocument();

    // One scroller for every section: the shell's pane body.
    const paneBody = document.querySelector<HTMLElement>(".pbody");
    expect(paneBody).not.toBeNull();
    expect(getComputedStyle(paneBody!).overflowY).toBe("auto");

    const after = cardMetrics();
    expect(after.computedHeight).toBe(before.computedHeight);

    if (before.height > 0 && after.height > 0) {
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(after.top).toBeCloseTo(before.top, 0);
    }
  });
});

// The redesign's search: filters the rail with amber match-count badges, shows
// "N matches" in the pane header, highlights matched substrings, auto-expands
// matching collapsed groups; `/` focuses, Esc clears before it closes.
describe("Settings search", () => {
  afterEach(async () => {
    await page.viewport(1280, 900);
  });

  const searchInput = () => page.getByRole("textbox", { name: m.settings_search_aria() });

  it("typing filters: badge on the rail, header count, highlights, group auto-expand", async () => {
    await page.viewport(1280, 900);
    await mountCodingAgents();

    // "mode" hits the Authentication mode row inside the collapsed Claude Code
    // group (title) — and nothing outside groups — so both the badge and the
    // auto-expand behavior are exercised. Expected counts come from the same
    // index the app derives them from, so copy edits can't desync this test.
    const { matchCount, sectionSearchRows } = await import("$lib/settings-search");
    const query = "mode";
    const expected = matchCount(sectionSearchRows({ provider: "claude" }).codingAgents, query);
    expect(expected).toBeGreaterThan(0);

    await searchInput().fill(query);

    // Rail badge on the Coding CLI tab shows the section's match count.
    const cliTab = page
      .getByRole("tab", { name: m.settings_tab_coding_agents(), exact: false })
      .element() as HTMLElement;
    await expect.poll(() => cliTab.textContent).toContain(String(expected));

    // Pane header shows the count for the active section.
    await expect
      .element(
        page.getByText(
          expected === 1
            ? m.settings_search_match_one({ query })
            : m.settings_search_matches({ count: expected, query }),
        ),
      )
      .toBeVisible();

    // The matching collapsed group auto-expanded and the substring is marked.
    const { button } = requiredCodingSectionButton(m.settings_cli_claude_title());
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => document.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("kept panels highlight their indexed labels too (badge ⇄ highlight parity)", async () => {
    await page.viewport(1280, 900);
    await mountCodingAgents();

    // A Device-only term: matches its indexed rows, so the Device rail badge
    // must light AND drilling in must show in-pane highlights — the four kept
    // panels receive the query even though their internals weren't rebuilt.
    const { matchCount, sectionSearchRows } = await import("$lib/settings-search");
    const query = "contrast";
    const expected = matchCount(sectionSearchRows({ provider: "claude" }).device, query);
    expect(expected).toBeGreaterThan(0);

    await searchInput().fill(query);

    const deviceTab = page
      .getByRole("tab", { name: m.settings_tab_device(), exact: false })
      .element() as HTMLElement;
    await expect.poll(() => deviceTab.textContent).toContain(String(expected));

    await page.getByRole("tab", { name: m.settings_tab_device(), exact: false }).click();
    const devicePanel = document.querySelector<HTMLElement>("#settings-panel-device");
    expect(devicePanel).not.toBeNull();
    await expect.poll(() => devicePanel!.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("counts and highlights matches in the Steers section", async () => {
    await page.viewport(1280, 900);
    await mountCodingAgents();

    const { matchCount, sectionSearchRows } = await import("$lib/settings-search");
    const query = "saved";
    const expected = matchCount(sectionSearchRows({ provider: "claude" }).steers, query);
    expect(expected).toBeGreaterThan(0);

    await searchInput().fill(query);

    const steersTab = page
      .getByRole("tab", { name: m.settings_tab_steers(), exact: false })
      .element() as HTMLElement;
    await expect.poll(() => steersTab.textContent).toContain(String(expected));

    await page.getByRole("tab", { name: m.settings_tab_steers(), exact: false }).click();
    const steersPanel = document.querySelector<HTMLElement>("#settings-panel-steers");
    expect(steersPanel).not.toBeNull();
    await expect.poll(() => steersPanel!.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("`/` focuses the search field; Esc clears the query, second Esc closes", async () => {
    await page.viewport(1280, 900);
    const onclose = vi.fn();
    render(Settings, { initialTab: "codingAgents", onclose, onsaved: noop });

    await userEvent.keyboard("/");
    const input = searchInput().element() as HTMLInputElement;
    await expect.poll(() => document.activeElement).toBe(input);

    await userEvent.keyboard("model");
    await expect.poll(() => input.value).toBe("model");

    // First Esc clears the query and must NOT close the dialog…
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => input.value).toBe("");
    expect(onclose).not.toHaveBeenCalled();

    // …the second (empty field) falls through to the dialog's close.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
  });
});

// The 5b mobile section list surfaces live current-value summaries and the
// diagnostics ISSUE chip (red, only while issues are active).
describe("Settings mobile section list", () => {
  afterEach(async () => {
    await page.viewport(1280, 900);
  });

  it("shows the diagnostics issue chip when a check is broken", async () => {
    await page.viewport(360, 900);
    render(Settings, {
      initialDiagnostics: [
        {
          id: "bun",
          state: "error" as const,
          hintKey: "diagnostics_hint_bun_missing",
        },
      ],
      onclose: noop,
      onsaved: noop,
    });

    await expect.element(page.getByText(m.settings_diag_issue_one())).toBeVisible();
  });

  it("shows no issue chip when diagnostics are clean", async () => {
    await page.viewport(360, 900);
    render(Settings, {
      initialDiagnostics: [{ id: "bun", state: "ok" as const, hintKey: "diagnostics_hint_bun_ok" }],
      onclose: noop,
      onsaved: noop,
    });

    await expect
      .element(page.getByRole("button", { name: m.settings_tab_diagnose(), exact: false }))
      .toBeVisible();
    await expect.element(page.getByText(m.settings_diag_issue_one())).not.toBeInTheDocument();
  });
});

// Regression guard for the issue's "no false success" criterion (PR #703): the green
// "Fixed" toast must only fire when the RE-PROBED snapshot shows the targeted check ok.
// A command that exits 0 but leaves the check non-ok (e.g. installer succeeds but its
// binary isn't on the server PATH) must surface the persistent "unresolved" toast, not
// a fake success.
describe("Settings diagnose one-click fix toast", () => {
  const bunBroken = (): DiagnosticCheck => ({
    id: "bun",
    state: "error",
    hintKey: "diagnostics_hint_bun_missing",
    remediation: "curl -fsSL https://bun.sh/install | bash",
  });

  function mountDiagnose() {
    render(Settings, {
      initialTab: "diagnose",
      initialDiagnostics: [bunBroken()],
      onclose: noop,
      onsaved: noop,
    });
  }

  async function clickFixThenRun() {
    await page.getByRole("button", { name: m.diagnostics_fix(), exact: true }).click();
    await page.getByRole("button", { name: m.diagnostics_fix_confirm_run(), exact: true }).click();
  }

  beforeEach(() => {
    mockFix.mockReset();
    toasts.items = []; // singleton store — clear so each assertion sees only its own toast
  });

  it("shows the success toast when the re-probe clears the check", async () => {
    mockFix.mockResolvedValue({
      checks: [{ id: "bun", state: "ok", hintKey: "diagnostics_hint_bun_ok" }],
      generatedAt: 1,
      overall: "ok",
    });
    mountDiagnose();
    await clickFixThenRun();

    await vi.waitFor(() => expect(mockFix).toHaveBeenCalledWith("bun"));
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.diagnostics_fix_success())).toBe(true),
    );
    expect(toasts.items.some((t) => t.text === m.diagnostics_fix_unresolved())).toBe(false);
  });

  it("shows the persistent unresolved toast (NOT success) when the check is still non-ok after exit 0", async () => {
    // Command resolved (2xx), but the re-probe still reports bun as error.
    mockFix.mockResolvedValue({
      checks: [bunBroken()],
      generatedAt: 1,
      overall: "error",
    });
    mountDiagnose();
    await clickFixThenRun();

    await vi.waitFor(() => expect(mockFix).toHaveBeenCalledWith("bun"));
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.diagnostics_fix_unresolved())).toBe(true),
    );
    // The critical assertion: no green "Fixed" toast on an unresolved check.
    expect(toasts.items.some((t) => t.text === m.diagnostics_fix_success())).toBe(false);
    // And the unresolved toast is an assertive 12s failure — durationMs set.
    const t = toasts.items.find((x) => x.text === m.diagnostics_fix_unresolved())!;
    expect(t.durationMs).toBe(12000);
  });
});

describe("Settings Codex reasoning", () => {
  it("preserves saved ultra through reload and resets it on an explicit unsupported model change", async () => {
    mockGetSettings.mockResolvedValue(
      settings({ recapCli: "codex", recapModel: "gpt-6-astra", recapEffort: "ultra" }),
    );
    const view = await mountCodingAgents();
    await requiredCodingSectionButton(m.settings_role_models_title()).disclosure.click();
    const effort = page.getByRole("combobox", {
      name: m.settings_role_effort_label({ role: "Recap" }),
    });
    await expect.element(effort).toHaveValue("ultra");
    await effort.selectOptions("max");
    await vi.waitFor(() => expect(putRoleEffort).toHaveBeenCalledWith("recapEffort", "max"));
    await effort.selectOptions("ultra");
    await vi.waitFor(() => expect(putRoleEffort).toHaveBeenCalledWith("recapEffort", "ultra"));
    await view.unmount();
    await mountCodingAgents();
    await requiredCodingSectionButton(m.settings_role_models_title()).disclosure.click();
    await expect.element(effort).toHaveValue("ultra");
    await page
      .getByRole("combobox", { name: m.settings_role_model_label({ role: "Recap" }) })
      .selectOptions("gpt-5.5");
    await expect.element(effort).toHaveValue("default");
    expect(putRoleEffort).toHaveBeenLastCalledWith("recapEffort", "default");
  });
  it("inherits Sol's ultra options and preserves stored intent when the global model changes", async () => {
    vi.mocked(putRoleEffort).mockClear();
    mockGetSettings.mockResolvedValue(
      settings({
        defaultAgentProvider: "codex",
        defaultCodexModel: "gpt-5.6-sol",
        recapCli: "inherit",
        recapEffort: "ultra",
      }),
    );
    await mountCodingAgents();
    await requiredCodingSectionButton(m.settings_role_models_title()).disclosure.click();
    const effort = page.getByRole("combobox", {
      name: m.settings_role_effort_label({ role: "Recap" }),
    });
    await expect.element(effort).toHaveValue("ultra");
    await page.getByTestId("default-environment-model").selectOptions("gpt-5.5");
    await expect.element(effort).toHaveValue("ultra");
    expect(putRoleEffort).not.toHaveBeenCalled();
  });
});

it("saves ultra as the shared default effort", async () => {
  await mountCodingAgents();
  await requiredCodingSectionButton(m.settings_cli_claude_title()).disclosure.click();
  const effort = page.getByRole("combobox", { name: m.settings_default_effort_title() });
  await effort.selectOptions("ultra");
  await vi.waitFor(() => expect(putDefaultEffort).toHaveBeenCalledWith("ultra"));
  await expect.element(effort).toHaveValue("ultra");
});

describe("Settings device — issue number on session cards", () => {
  afterEach(() => {
    issueRef.set(true); // leave the shared singleton on its default for other suites
  });

  it("flips the per-device preference and reflects it in the switch state", async () => {
    await page.viewport(1280, 900);
    render(Settings, { initialTab: "device", onclose: noop, onsaved: noop });

    const sw = page.getByRole("switch", { name: m.settings_card_issue_ref_on() });
    await expect.element(sw).toHaveAttribute("aria-checked", "true");

    await sw.click();
    await vi.waitFor(() => expect(issueRef.shown).toBe(false));
    await expect
      .element(page.getByRole("switch", { name: m.settings_card_issue_ref_off() }))
      .toHaveAttribute("aria-checked", "false");
  });
});
