import { getVoiceStatus, transcribeAudio } from "$lib/api";
import { getLocale } from "$lib/i18n";
import { pcmChunksToWavBlob } from "$lib/wav";

// Reusable dictation controller — the engine behind every mic in the app, extracted from
// ComposeBar so further fields cost one MicButton each instead of ~250 inlined lines.
//
// Two engines, picked per session:
//  • Web Speech (Chrome/Android, Safari browser tab): the browser transcribes live. This is
//    NOT the iOS keyboard's native dictation mic — no web API can summon that — and WebKit
//    doesn't expose it inside an iOS home-screen PWA at all.
//  • Local Whisper (the optional voice-whisper plugin, issue #76): record with MediaRecorder,
//    POST the clip to the plugin, insert the returned text. The ONLY mic in an iOS PWA.
//    While recording, a Web-Audio tap on the same stream feeds a live read-along preview:
//    the PCM captured so far is encoded as a WAV (valid at every prefix — unlike an iOS
//    MediaRecorder mp4, whose `moov` atom is written only on stop) and re-transcribed every
//    INTERIM_MS with `mode=partial`, so the plugin's load gate keeps a slot free for the
//    final full-clip transcription that replaces the preview on stop.
//
// The host owns the text field; the controller only reads/writes through the DictationHost
// callbacks and never touches the DOM. One controller per field.

export interface DictationHost {
  /** Current field text (dictation appends after it). */
  getText(): string;
  /** Replace the field text (live preview + final transcript). */
  setText(text: string): void;
  /** Called DEFERRED (queueMicrotask) after every setText, once the reactive write has
   *  flushed — so an autogrow handler measures the fresh scrollHeight, never a stale one. */
  onTextRendered?(): void;
}

// Minimal SpeechRecognition interface — the W3C Web Speech API types are not yet in
// TypeScript's built-in lib.dom.d.ts (only the event/result sub-types are), so we declare
// the constructor/instance shape we actually consume.
interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}
interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
interface AudioWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

const MAX_RECORD_MS = 60_000; // cap a single clip so a forgotten mic can't record forever
const INTERIM_MS = 2500; // how often to re-transcribe the growing clip for the live preview

/** One dictation engine bound to one text field. Engine/browser capabilities are probed at
 *  creation time (not module load), so tests can stub the globals before mounting a host. */
export function createDictation(host: DictationHost) {
  const SpeechRec: SpeechRecognitionConstructor | undefined =
    typeof window !== "undefined"
      ? ((window as SpeechWindow).SpeechRecognition ??
        (window as SpeechWindow).webkitSpeechRecognition)
      : undefined;
  const AudioCtx: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as AudioWindow).webkitAudioContext)
      : undefined;
  const speechSupported = !!SpeechRec;

  // The client must actually be able to record — MediaRecorder + getUserMedia. Without them a
  // server-available plugin still can't be used from this browser, so treat local as unusable.
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  let localVoiceAvailable = $state(false);
  let preferLocal = $state(false);
  let listening = $state(false);
  let transcribing = $state(false);
  let voiceError = $state(false);
  let voiceErrorTimer: ReturnType<typeof setTimeout> | null = null;

  const localUsable = $derived(localVoiceAvailable && recorderSupported);
  // The mic shows whenever *either* engine can run; `useLocal` picks which engine a NEW tap
  // starts — local when Web Speech is absent (iOS PWA) or the plugin asks to be preferred,
  // else the browser's live dictation. It can flip mid-session (the status probe resolving
  // after an auto-started dictation), so it must NOT decide how to STOP an in-flight session.
  const micVisible = $derived(speechSupported || localUsable);
  const useLocal = $derived(localUsable && (!speechSupported || preferLocal));

  // Which engine actually owns the live recording, fixed when it starts. toggle() stops THIS
  // one rather than re-reading `useLocal`, so a mid-session flip never strands the recorder.
  let activeEngine = $state<"web" | "local" | null>(null);

  // Which engine to name on the origin label: the engine that owns the live recording, or
  // "local" during the post-recording batch transcription. `transcribing` is set on the local
  // path only (Web Speech transcribes live and never sets it), so it unambiguously means local
  // — this keeps the label up across BOTH the recording and the transcription phase, then
  // clears once both are done. It names the origin of THIS recording only — never plugin
  // health/availability.
  const originEngine = $derived(activeEngine ?? (transcribing ? "local" : null));

  // The controller is the single owner of the plugin-status probe (memoized in api.ts).
  // `ready` IS the promise that applies the result, so anything chained on it is guaranteed
  // to observe localVoiceAvailable/preferLocal/useLocal already applied — hosts must never
  // register their own getVoiceStatus().then and race this one.
  const ready: Promise<void> = getVoiceStatus()
    .then((s) => {
      localVoiceAvailable = s.available;
      preferLocal = s.preferLocal;
    })
    .catch(() => {});

  let recog: SpeechRecognitionInstance | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let recordTimer: ReturnType<typeof setTimeout> | null = null;

  let audioCtx: AudioContext | null = null;
  let audioSource: MediaStreamAudioSourceNode | null = null;
  let audioProc: ScriptProcessorNode | null = null;
  let audioSink: GainNode | null = null;
  let pcmChunks: Float32Array[] = [];
  let pcmRate = 0;
  let interimTimer: ReturnType<typeof setInterval> | null = null;
  let interimBusy = false; // one interim request in flight at a time — never stack transcriptions
  let interimSeq = 0; // bumped to discard a stale/late interim response (incl. after stop)
  let dictationBase = ""; // field text when recording started; interim/final render after it

  // Every text write goes through here: set, then notify the host DEFERRED so its
  // autogrow-style handler measures the post-flush layout (the queueMicrotask(autogrow)
  // pattern the pre-extraction ComposeBar used).
  function render(text: string) {
    host.setText(text);
    queueMicrotask(() => host.onTextRendered?.());
  }

  function pickMimeType(): string | undefined {
    if (typeof MediaRecorder === "undefined") return undefined;
    for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"])
      if (MediaRecorder.isTypeSupported(c)) return c;
    return undefined; // let the browser choose its default container
  }

  function flashVoiceError() {
    voiceError = true;
    if (voiceErrorTimer) clearTimeout(voiceErrorTimer);
    voiceErrorTimer = setTimeout(() => (voiceError = false), 4000);
  }

  // Tap the live mic stream with Web Audio and start the interim-transcription loop.
  // Best-effort: if Web Audio is unavailable or setup throws, we bail quietly and the final
  // clip still runs.
  function startInterimCapture(stream: MediaStream) {
    if (!AudioCtx) return;
    try {
      // Ask for 16 kHz directly so the browser resamples for us; fall back to the device rate.
      try {
        audioCtx = new AudioCtx({ sampleRate: 16000 });
      } catch {
        audioCtx = new AudioCtx();
      }
      void audioCtx.resume?.().catch(() => {});
      pcmRate = audioCtx.sampleRate;
      pcmChunks = [];
      audioSource = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated in favour of AudioWorklet, but the worklet needs a
      // separately bundled module; ScriptProcessor is the simplest path that also works in an
      // iOS PWA. A 60 s dictation on the main thread is well within its budget.
      audioProc = audioCtx.createScriptProcessor(4096, 1, 1);
      audioProc.onaudioprocess = (e) => {
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // Route through a muted gain into the destination so the processor actually runs,
      // without echoing the mic back to the speakers.
      audioSink = audioCtx.createGain();
      audioSink.gain.value = 0;
      audioSource.connect(audioProc);
      audioProc.connect(audioSink);
      audioSink.connect(audioCtx.destination);
      interimTimer = setInterval(() => void runInterim(), INTERIM_MS);
    } catch {
      stopInterimCapture();
    }
  }

  // One interim tick: transcribe the clip captured so far and show it live. Guarded so only
  // one request is ever in flight, and a stale/late response (a newer tick, or one arriving
  // after we stopped) is discarded via the sequence number. `mode: "partial"` marks the
  // request disposable so the plugin's load gate keeps a slot free for the final clip.
  async function runInterim() {
    if (interimBusy || transcribing || !listening) return;
    if (pcmChunks.length === 0 || pcmRate === 0) return;
    const blob = pcmChunksToWavBlob(pcmChunks, pcmRate);
    interimBusy = true;
    const seq = ++interimSeq;
    try {
      const text = await transcribeAudio(blob, getLocale() === "de" ? "de" : "en", {
        mode: "partial",
      });
      if (seq === interimSeq && listening && text)
        render(dictationBase.trim() ? dictationBase.trimEnd() + " " + text.trim() : text.trim());
    } catch {
      // interim is best-effort — a failed/shed tick is silently skipped; the final clip still runs
    } finally {
      interimBusy = false;
    }
  }

  function stopInterimCapture() {
    if (interimTimer) {
      clearInterval(interimTimer);
      interimTimer = null;
    }
    interimSeq++; // invalidate any in-flight interim response
    interimBusy = false;
    if (audioProc) audioProc.onaudioprocess = null;
    try {
      audioProc?.disconnect();
      audioSource?.disconnect();
      audioSink?.disconnect();
    } catch {
      /* nodes already torn down */
    }
    audioProc = null;
    audioSource = null;
    audioSink = null;
    if (audioCtx) {
      void audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    pcmChunks = [];
    pcmRate = 0;
  }

  // Start recording via the local plugin. Must be reached within the getUserMedia
  // user-activation window (a mic tap, or autoStart() with the status probe pre-resolved).
  // `acquiring` guards the getUserMedia await so an auto-start and a fast manual tap can't
  // both open a stream.
  let acquiring = false;
  async function startLocal() {
    if (listening || transcribing || acquiring) return;
    if (!recorderSupported) {
      flashVoiceError();
      return;
    }
    acquiring = true;
    voiceError = false;
    try {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        flashVoiceError();
        return;
      }
      const mimeType = pickMimeType();
      chunks = [];
      // MediaRecorder construction or start() can throw (unsupported mimeType, hardware in
      // use); release the just-acquired mic stream so it isn't left open on failure.
      try {
        mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        mediaRecorder.onstop = () => void finishLocalRecording();
        mediaRecorder.start();
      } catch {
        mediaRecorder = null;
        releaseStream();
        flashVoiceError();
        return;
      }
      listening = true;
      activeEngine = "local";
      recordTimer = setTimeout(() => stopLocal(), MAX_RECORD_MS);
      // Start the live read-along preview off the same stream (best-effort; the final clip
      // above is authoritative and runs regardless of whether interim capture succeeds).
      dictationBase = host.getText();
      if (mediaStream) startInterimCapture(mediaStream);
    } finally {
      acquiring = false;
    }
  }

  // User-initiated stop → let onstop fire finishLocalRecording (which uploads + inserts).
  function stopLocal() {
    if (recordTimer) {
      clearTimeout(recordTimer);
      recordTimer = null;
    }
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    listening = false;
  }

  async function finishLocalRecording() {
    const type = mediaRecorder?.mimeType || "audio/webm";
    stopInterimCapture();
    releaseStream();
    mediaRecorder = null;
    activeEngine = null;
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type });
    chunks = [];
    transcribing = true;
    try {
      // The final clip sends NO mode — the plugin treats absent mode as the one
      // transcription its load gate reserves a slot for.
      const text = await transcribeAudio(blob, getLocale() === "de" ? "de" : "en");
      // The accurate full-clip result replaces whatever the live preview last showed. On
      // error we keep the last interim text rather than discarding what the user dictated.
      render(dictationBase);
      if (text) appendTranscript(text);
    } catch {
      flashVoiceError();
    } finally {
      transcribing = false;
    }
  }

  function releaseStream() {
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  // Tear down an in-progress recording WITHOUT uploading (dismiss/submit/destroy): drop the
  // onstop handler first so stopping never triggers a transcription of a discarded clip.
  function teardownRecording() {
    if (recordTimer) {
      clearTimeout(recordTimer);
      recordTimer = null;
    }
    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = null;
      if (mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.stop();
        } catch {
          /* already stopped */
        }
      }
      mediaRecorder = null;
    }
    stopInterimCapture();
    releaseStream();
    chunks = [];
    listening = false;
    activeEngine = null;
  }

  // Append transcribed text after whatever is already in the field (the join rule both the
  // interim preview and Web Speech use).
  function appendTranscript(text: string) {
    const t = text.trim();
    if (!t) return;
    const cur = host.getText();
    render(cur.trim() ? cur.trimEnd() + " " + t : t);
  }

  // Start a Web Speech session — the browser transcribes live straight into the field.
  function startWeb() {
    if (!SpeechRec || listening || transcribing) return;
    recog = new SpeechRec();
    recog.lang = getLocale() === "de" ? "de-DE" : "en-US";
    recog.interimResults = true;
    recog.continuous = true;
    let base = host.getText(); // text already typed before dictation started
    recog.onresult = (e: SpeechRecognitionEvent) => {
      let finalChunk = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) base = (base ? base.trimEnd() + " " : "") + finalChunk.trim();
      render(interim ? (base ? base.trimEnd() + " " : "") + interim.trim() : base);
    };
    recog.onend = () => {
      listening = false;
      activeEngine = null;
    };
    recog.onerror = () => {
      listening = false;
      activeEngine = null;
    };
    recog.start();
    listening = true;
    activeEngine = "web";
  }

  function stopWeb() {
    recog?.stop();
  }

  // One mic tap. A live session is stopped by the engine that STARTED it (not the current
  // `useLocal`, which may have flipped mid-session) — otherwise the active recorder is never
  // stopped. A fresh tap starts whichever engine `useLocal` picks now.
  function toggle() {
    if (transcribing) return;
    if (activeEngine === "local") {
      stopLocal();
    } else if (activeEngine === "web") {
      stopWeb();
    } else if (useLocal) {
      void startLocal();
    } else {
      startWeb();
    }
  }

  // "Open already listening" (ComposeBar's ◉ dictate entry). Reproduces the pre-extraction
  // mount order with no .then-registration race: Web Speech starts synchronously (never
  // delayed by the probe); the local branch chains on `ready` — the controller's OWN status
  // application — so its guard always reads applied state, and is skipped when the web engine
  // is already listening. The probe is memoized and pre-resolved by the host's entry point
  // (ViewportTermControls), so `ready` settles in the same turn and getUserMedia stays inside
  // the tap's user-activation window; a denial just flashes an error.
  function autoStart() {
    if (speechSupported) startWeb();
    void ready.then(() => {
      if (useLocal && !listening && !transcribing) void startLocal();
    });
  }

  // Full stop for dismiss/submit/destroy: discard any in-flight recording WITHOUT uploading,
  // silence late Web Speech results, and reset every one-shot guard (incl. the error flash).
  function teardown() {
    if (recog) {
      recog.onresult = null;
      recog.onend = null;
      recog.onerror = null;
      try {
        recog.stop();
      } catch {
        /* already stopped */
      }
      recog = null;
    }
    teardownRecording();
    if (voiceErrorTimer) {
      clearTimeout(voiceErrorTimer);
      voiceErrorTimer = null;
    }
    voiceError = false;
  }

  return {
    /** Either engine can run — render the mic. */
    get micVisible() {
      return micVisible;
    },
    get listening() {
      return listening;
    },
    /** Local batch transcription in flight (recording already stopped). */
    get transcribing() {
      return transcribing;
    },
    get voiceError() {
      return voiceError;
    },
    /** Engine that owns the CURRENT recording/transcription — provenance, not health. */
    get originEngine() {
      return originEngine;
    },
    get useLocal() {
      return useLocal;
    },
    get speechSupported() {
      return speechSupported;
    },
    /** Resolves once the plugin-status probe has been APPLIED to controller state. */
    ready,
    toggle,
    autoStart,
    startLocal,
    startWeb,
    teardown,
  };
}
