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
  fixDiagnostic,
} from "$lib/api";
import { toasts } from "$lib/toasts.svelte";

// Mock the API so Settings never hits the network. The settings GET is seeded to
// land on api-key mode WITH a key configured, so the api-key block + Verify button
// render; each test then drives verifyApiKey / putAnthropicApiKey.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getSettings: vi.fn(),
    listDirs: vi.fn(async () => ({ path: "/repo", display: "/repo", parent: null, entries: [] })),
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
const mockFix = vi.mocked(fixDiagnostic);

function settings(over: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    repoRoot: "/repo",
    repoRootDisplay: "/repo",
    firstRunPending: false,
    remoteControlAtStartup: false,
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
    rundownCli: "claude",
    rundownModel: "sonnet",
    rundownEffort: "low",
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

function mountCodingAgents() {
  return render(Settings, { initialTab: "codingAgents", onclose: noop, onsaved: noop });
}

async function mountClaudeApiKeySettings() {
  await mountCodingAgents();
  const { disclosure, button } = requiredCodingSectionButton(m.settings_cli_claude_title());
  if (button.getAttribute("aria-expanded") === "false") {
    await disclosure.click();
  }
}

const codingSectionNames = () => [
  m.settings_cli_defaults_title(),
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
  expect(button, `missing Coding CLI disclosure button named "${name}"`).not.toBeNull();
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
  const names = codingSectionNames();
  for (const [index, name] of names.entries()) {
    const { button } = requiredCodingSectionButton(name);
    const expanded = index === 0;
    expect(button.getAttribute("aria-expanded")).toBe(String(expanded));
    expect(controlledSection(button).hidden).toBe(!expanded);
  }
}

describe("Settings Coding CLI sections", () => {
  it("renders the four named disclosures in order with only Global defaults open", async () => {
    await mountCodingAgents();

    const names = codingSectionNames();
    const buttons: HTMLElement[] = [];
    for (const name of names) {
      buttons.push(requiredCodingSectionButton(name).button);
    }

    for (let index = 0; index < buttons.length - 1; index += 1) {
      expect(
        buttons[index].compareDocumentPosition(buttons[index + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    for (const [index, button] of buttons.entries()) {
      const expanded = index === 0;
      expect(button.getAttribute("aria-expanded")).toBe(String(expanded));
      expect(controlledSection(button).hidden).toBe(!expanded);
    }
  });

  it("click toggles a collapsed section without replacing its controlled content", async () => {
    await mountCodingAgents();
    const { disclosure, button } = requiredCodingSectionButton(m.settings_cli_claude_title());
    const content = controlledSection(button);
    expect(content.hidden).toBe(true);

    await disclosure.click();
    await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(content.id)).toBe(content);
    expect(content.hidden).toBe(false);

    const { button: defaultsButton } = requiredCodingSectionButton(m.settings_cli_defaults_title());
    expect(defaultsButton.getAttribute("aria-expanded")).toBe("true");
    expect(controlledSection(defaultsButton).hidden).toBe(false);

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

  it("preserves an expanded section while switching Settings tabs", async () => {
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

  it("resets to only Global defaults open after Settings is remounted", async () => {
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
  it("shows the saved Herd Rundown CLI, model, and effort", async () => {
    await mountCodingAgents();
    const { disclosure } = requiredCodingSectionButton(m.settings_role_models_title());
    await disclosure.click();

    const role = "Herd Rundown";
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
    mountCodingAgents();

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
    mountCodingAgents();

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
    mountCodingAgents();

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
    mountCodingAgents();

    const model = page.getByTestId("default-environment-model");
    await model.selectOptions("gpt-5.6-luna");

    await expect.element(model).toHaveValue("gpt-5.4");
    await vi.waitFor(() =>
      expect(
        toasts.items.some((toast) => toast.text === m.settings_default_codex_model_save_failed()),
      ).toBe(true),
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

// Regression: on a narrow viewport the tab strip can't fit one row in the card and,
// when full-screen, the overflow is clipped — the Plugins tab (last in the visible
// set when present) used to land off-screen. It now collapses into a dropdown so
// every tab stays reachable. On desktop the strip wraps and keeps tab semantics.
describe("Settings responsive tab navigation", () => {
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

  it("narrow viewport → tabs collapse into a dropdown that lists the Plugins tab", async () => {
    await page.viewport(360, 900); // ≤768px → mobile dropdown
    render(Settings, { plugins: onePlugin, onclose: noop, onsaved: noop });

    // The strip is replaced by a single labelled combobox…
    await expect
      .element(page.getByRole("combobox", { name: m.settings_tabs_aria() }))
      .toBeInTheDocument();
    // …and Plugins is reachable as an option (it was clipped off-screen before).
    await expect
      .element(page.getByRole("option", { name: m.settings_tab_plugins() }))
      .toBeInTheDocument();
    // No tablist tab in this mode.
    await expect
      .element(page.getByRole("tab", { name: m.settings_tab_plugins() }))
      .not.toBeInTheDocument();
    // The active panel is a plain labelled region here (no tablist to own a tabpanel).
    await expect
      .element(page.getByRole("region", { name: m.settings_tab_workspace() }))
      .toBeInTheDocument();
  });

  it("desktop viewport → Plugins renders as a tab and the panel is a tabpanel", async () => {
    await page.viewport(1280, 900); // >768px → tablist strip
    render(Settings, { plugins: onePlugin, onclose: noop, onsaved: noop });

    await expect
      .element(page.getByRole("tab", { name: m.settings_tab_plugins() }))
      .toBeInTheDocument();
    // The active panel carries the tab pattern's tabpanel role on desktop.
    await expect
      .element(page.getByRole("tabpanel", { name: m.settings_tab_workspace() }))
      .toBeInTheDocument();
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

  it("desktop tab switches keep the modal shell stable", async () => {
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

    const sessionPanel = document.querySelector<HTMLElement>("#settings-panel-session");
    expect(sessionPanel).not.toBeNull();
    expect(getComputedStyle(sessionPanel!).overflowY).toBe("auto");

    const after = cardMetrics();
    expect(after.computedHeight).toBe(before.computedHeight);

    if (before.height > 0 && after.height > 0) {
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(after.top).toBeCloseTo(before.top, 0);
    }
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
