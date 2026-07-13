import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { getCommands, getVoiceStatus, transcribeAudio } from "$lib/api";
import { m } from "$lib/paraglide/messages";
import type { SlashCommand } from "$lib/types";

// Mock the API so the compose sheet renders deterministically with no network. Mocking
// getVoiceStatus/transcribeAudio also lets the tests prove that a discarded recording is
// NEVER uploaded (the teardown guarantee).
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getCommands: vi.fn(),
    getVoiceStatus: vi.fn(),
    transcribeAudio: vi.fn(),
  };
});

const { default: ComposeBar } = await import("./ComposeBar.svelte");

const mockGetCommands = vi.mocked(getCommands);
const mockGetVoiceStatus = vi.mocked(getVoiceStatus);
const mockTranscribeAudio = vi.mocked(transcribeAudio);

// Deterministic Web Speech stand-in. The dictation controller looks up
// window.SpeechRecognition ?? window.webkitSpeechRecognition at creation time, so installing
// this on window.SpeechRecognition before render() makes it the engine (it wins the ??
// even though Chromium ships webkitSpeechRecognition).
interface FakeResultChunk {
  transcript: string;
  isFinal: boolean;
}
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  started = 0;
  stopped = 0;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.onend?.();
  }
  /** Fire onresult with the shape the controller consumes: results[i][0].transcript + isFinal. */
  emit(chunks: FakeResultChunk[]) {
    this.onresult?.({
      resultIndex: 0,
      results: chunks.map((c) =>
        Object.assign([{ transcript: c.transcript }], { isFinal: c.isFinal }),
      ),
    });
  }
}

type SpeechWindow = Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
const w = window as SpeechWindow;
const originalWebkitSpeech = w.webkitSpeechRecognition;

const voiceAbsent = {
  available: false,
  engine: null,
  model: null,
  ffmpeg: false,
  language: "auto",
  preferLocal: false,
  hint: "",
};

beforeEach(() => {
  FakeRecognition.instances = [];
  w.SpeechRecognition = FakeRecognition;
  mockGetCommands.mockReset();
  mockGetVoiceStatus.mockReset();
  mockTranscribeAudio.mockReset();
  mockGetCommands.mockResolvedValue({ commands: [] });
  mockGetVoiceStatus.mockResolvedValue(voiceAbsent);
  mockTranscribeAudio.mockResolvedValue("never used");
});

afterEach(() => {
  delete w.SpeechRecognition;
  w.webkitSpeechRecognition = originalWebkitSpeech;
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  onsend: vi.fn(),
  onclose: vi.fn(),
  repoPath: "/repo",
  ...extra,
});

function slashCommand(name: string, providers: SlashCommand["providers"]): SlashCommand {
  return {
    id: `test:${name}`,
    name,
    displayName: name,
    description: `${name} description`,
    scope: "project",
    kind: "skill",
    invocationName: name,
    sourceNamespace: providers?.includes("codex") ? "codex:repo" : "claude:repo",
    providers,
    invocations: {
      ...(providers?.includes("claude") ? { claude: `/${name}` } : {}),
      ...(providers?.includes("codex") ? { codex: `$${name}` } : {}),
    },
  };
}

const micBtn = () => page.getByRole("button", { name: m.composebar_dictate_aria() });
const stopBtn = () => page.getByRole("button", { name: m.composebar_dictate_stop_aria() });
const field = () => page.getByRole("textbox", { name: m.composebar_input_aria() });

describe("ComposeBar dictation (shared controller wiring)", () => {
  it("shows the mic when Web Speech is available; a tap starts recognition", async () => {
    render(ComposeBar, base());
    await expect.element(micBtn()).toBeVisible();
    await micBtn().click();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0]!.started).toBe(1);
    // While listening the button reads as the stop control and is pressed.
    await expect.element(stopBtn()).toBeVisible();
    await expect.element(stopBtn()).toHaveAttribute("aria-pressed", "true");
  });

  it("renders no mic when neither engine is available", async () => {
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
    render(ComposeBar, base());
    // Send is always there; once it is visible the sheet has settled without a mic.
    await expect
      .element(page.getByRole("button", { name: m.composebar_send_aria() }))
      .toBeVisible();
    expect(micBtn().query()).toBeNull();
  });

  it("writes interim and final results into the field with the join rule", async () => {
    render(ComposeBar, base());
    await field().fill("typed first");
    await micBtn().click();
    const rec = FakeRecognition.instances[0]!;
    rec.emit([{ transcript: " hello world", isFinal: false }]);
    // interim renders after the pre-typed base…
    await expect.element(field()).toHaveValue("typed first hello world");
    // …and a final chunk replaces the interim with the settled text.
    rec.emit([{ transcript: " hello world.", isFinal: true }]);
    await expect.element(field()).toHaveValue("typed first hello world.");
  });

  it("startDictation auto-starts the web engine on mount", async () => {
    render(ComposeBar, base({ startDictation: true }));
    await expect.element(stopBtn()).toBeVisible();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(FakeRecognition.instances[0]!.started).toBe(1);
  });

  it("Send mid-recording stops recognition, sends the field text, uploads nothing", async () => {
    const onsend = vi.fn();
    render(ComposeBar, base({ onsend }));
    await micBtn().click();
    const rec = FakeRecognition.instances[0]!;
    rec.emit([{ transcript: "take this", isFinal: false }]);
    await expect.element(field()).toHaveValue("take this");
    await page.getByRole("button", { name: m.composebar_send_aria() }).click();
    expect(rec.stopped).toBeGreaterThan(0);
    expect(onsend).toHaveBeenCalledWith("take this");
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });

  it("cancel (✕) mid-recording stops recognition and uploads nothing", async () => {
    const onclose = vi.fn();
    render(ComposeBar, base({ onclose }));
    await micBtn().click();
    const rec = FakeRecognition.instances[0]!;
    // The ✕ acts on pointerdown (so it never blurs the soft keyboard); Playwright's click
    // refuses it because the autogrown textarea's hit-area overlaps — dispatch the event
    // the handler actually listens for.
    const closeEl = page.getByRole("button", { name: m.common_close() }).query()!;
    closeEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(rec.stopped).toBeGreaterThan(0);
    expect(onclose).toHaveBeenCalled();
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });
});

describe("ComposeBar provider-aware command picker", () => {
  it("filters to Codex commands and inserts a dollar mention in place", async () => {
    mockGetCommands.mockResolvedValue({
      commands: [slashCommand("claude-only", ["claude"]), slashCommand("codex-only", ["codex"])],
    });
    render(ComposeBar, base({ agentProvider: "codex" }));

    await field().fill("use $cod");
    await expect.element(page.getByText("$codex-only")).toBeVisible();
    expect(page.getByText("/claude-only").query()).toBeNull();
    await page.getByText("$codex-only").click();

    await expect.element(field()).toHaveValue("use $codex-only ");
  });
});
