import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { getVoiceStatus, transcribeAudio } from "$lib/api";
import { m } from "$lib/paraglide/messages";

// Mock the API so engine detection is deterministic and so the tests can prove a discarded
// recording is never uploaded.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getVoiceStatus: vi.fn(),
    transcribeAudio: vi.fn(),
  };
});

const { default: MicButton } = await import("./MicButton.svelte");

const mockGetVoiceStatus = vi.mocked(getVoiceStatus);
const mockTranscribeAudio = vi.mocked(transcribeAudio);

// Deterministic Web Speech stand-in — installed on window.SpeechRecognition so it wins the
// controller's `SpeechRecognition ?? webkitSpeechRecognition` lookup (done at creation time).
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
  // The button positions itself UPWARD from its zero-height anchor (in real usage a text
  // field sits above it); standalone the anchor is at y=0, which would put the button above
  // the viewport where Playwright refuses to click. Give the body headroom instead.
  document.body.style.paddingTop = "120px";
  mockGetVoiceStatus.mockReset();
  mockTranscribeAudio.mockReset();
  mockGetVoiceStatus.mockResolvedValue(voiceAbsent);
  mockTranscribeAudio.mockResolvedValue("never used");
});

afterEach(() => {
  delete w.SpeechRecognition;
  w.webkitSpeechRecognition = originalWebkitSpeech;
  document.body.style.paddingTop = "";
  document.body.innerHTML = "";
});

function makeHost() {
  const host = { value: "", rendered: 0 };
  return {
    host,
    props: {
      getText: () => host.value,
      setText: (t: string) => (host.value = t),
      onTextRendered: () => host.rendered++,
    },
  };
}

const micBtn = () => page.getByRole("button", { name: m.micbtn_dictate_aria() });
const stopBtn = () => page.getByRole("button", { name: m.micbtn_dictate_stop_aria() });

describe("MicButton", () => {
  it("renders the mic when Web Speech is available; tap toggles a session", async () => {
    const { props } = makeHost();
    render(MicButton, props);
    await expect.element(micBtn()).toBeVisible();
    await micBtn().click();
    const rec = FakeRecognition.instances[0]!;
    expect(rec.started).toBe(1);
    await expect.element(stopBtn()).toHaveAttribute("aria-pressed", "true");
    // second tap stops the session that was started
    await stopBtn().click();
    expect(rec.stopped).toBeGreaterThan(0);
    await expect.element(micBtn()).toHaveAttribute("aria-pressed", "false");
  });

  it("renders nothing when neither engine is available", async () => {
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
    const { props } = makeHost();
    render(MicButton, props);
    // getVoiceStatus resolved unavailable → micVisible stays false; give the probe a tick
    await mockGetVoiceStatus.mock.results[0]?.value;
    expect(micBtn().query()).toBeNull();
    expect(document.querySelector(".micbtn-anchor")).toBeNull();
  });

  it("appears via the plugin engine when Web Speech is absent but the plugin is ready", async () => {
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
    mockGetVoiceStatus.mockResolvedValue({
      ...voiceAbsent,
      available: true,
      engine: "whisper.cpp",
      model: "ggml-small.bin",
    });
    const { props } = makeHost();
    render(MicButton, props);
    // Chromium has MediaRecorder + getUserMedia, so localUsable flips true once the
    // (controller-owned) probe applies — the mic must appear without any tap.
    await expect.element(micBtn()).toBeVisible();
  });

  it("writes results through setText with the join rule and defers onTextRendered", async () => {
    const { host, props } = makeHost();
    host.value = "typed base";
    render(MicButton, props);
    await micBtn().click();
    const rec = FakeRecognition.instances[0]!;
    const renderedBefore = host.rendered;
    rec.emit([{ transcript: " hello", isFinal: false }]);
    // setText is synchronous, the render callback is deferred (queueMicrotask) so an
    // autogrow handler measures the post-flush layout.
    expect(host.value).toBe("typed base hello");
    expect(host.rendered).toBe(renderedBefore);
    await Promise.resolve();
    expect(host.rendered).toBe(renderedBefore + 1);
    rec.emit([{ transcript: " hello there.", isFinal: true }]);
    expect(host.value).toBe("typed base hello there.");
  });

  it("releases a stream that resolves after teardown and never starts recording", async () => {
    // Local-engine path: unmount while the getUserMedia permission prompt is still pending,
    // then let it resolve — the orphaned stream must be released, and no MediaRecorder may
    // ever start (it would otherwise keep the mic open and upload a discarded clip).
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
    mockGetVoiceStatus.mockResolvedValue({
      ...voiceAbsent,
      available: true,
      engine: "whisper.cpp",
      model: "ggml-small.bin",
    });
    const mediaDevices = navigator.mediaDevices as { getUserMedia: unknown };
    const originalGetUserMedia = mediaDevices.getUserMedia;
    const originalMediaRecorder = window.MediaRecorder;
    let resolveAcquisition!: (stream: unknown) => void;
    const stopTrack = vi.fn();
    const recorderCtor = vi.fn();
    mediaDevices.getUserMedia = () => new Promise((r) => (resolveAcquisition = r));
    window.MediaRecorder = class {
      constructor() {
        recorderCtor();
      }
      static isTypeSupported() {
        return false;
      }
    } as unknown as typeof MediaRecorder;
    try {
      const { props } = makeHost();
      const screen = await render(MicButton, props);
      await expect.element(micBtn()).toBeVisible();
      await micBtn().click(); // startLocal() now awaits the pending permission prompt
      screen.unmount(); // teardown while acquiring
      resolveAcquisition({ getTracks: () => [{ stop: stopTrack }] });
      await new Promise((r) => setTimeout(r, 0));
      expect(stopTrack).toHaveBeenCalled();
      expect(recorderCtor).not.toHaveBeenCalled();
      expect(mockTranscribeAudio).not.toHaveBeenCalled();
    } finally {
      mediaDevices.getUserMedia = originalGetUserMedia;
      window.MediaRecorder = originalMediaRecorder;
    }
  });

  it("unmount mid-recording stops recognition and uploads nothing", async () => {
    const { props } = makeHost();
    const screen = await render(MicButton, props);
    await micBtn().click();
    const rec = FakeRecognition.instances[0]!;
    expect(rec.started).toBe(1);
    screen.unmount();
    expect(rec.stopped).toBeGreaterThan(0);
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });
});
