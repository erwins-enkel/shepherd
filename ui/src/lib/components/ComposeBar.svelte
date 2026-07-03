<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { getLocale } from "$lib/i18n";
  import { insertNewlineAt } from "$lib/compose";
  import { getCommands, getVoiceStatus, transcribeAudio } from "$lib/api";
  import { pcmChunksToWavBlob } from "$lib/wav";
  import { matchSlashTrigger, filterCommands, applyCommandPick } from "$lib/slash";
  import type { SlashCommand } from "$lib/types";
  import SlashCommandMenu from "./SlashCommandMenu.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";

  // Centered compose overlay: a real <textarea> (not xterm's hidden one) so
  // Android autocomplete / suggestions / double-space-period resolve natively
  // in the field. We read its value once, on explicit submit — never diffing
  // per-keystroke into the PTY — so xterm's IME duplication bug can't occur.
  // The overlay floats over the terminal with a blurred backdrop; the parent
  // mounts it on demand (swipe-up / ✎ chip) and decides how to inject the text.
  // Presentational: owns its own text + newline editing + dictation + slash
  // picker, emits the composed string via onsend and a dismissal via onclose.
  // repoPath powers the inline slash-command picker (same /api/commands index
  // as New Task), so a leading `/` offers the session repo's commands.
  let {
    onsend,
    onclose,
    repoPath,
    startDictation = false,
  }: {
    onsend: (text: string) => void;
    onclose: () => void;
    repoPath: string;
    // open the overlay already listening (mic entry); typing-only entries pass
    // false so the keyboard comes up without recording
    startDictation?: boolean;
  } = $props();

  let value = $state("");
  let ta = $state<HTMLTextAreaElement>();
  let overlayEl = $state<HTMLDivElement>();

  // ── inline slash-command autocomplete (mirrors NewTask, opens upward) ──
  let allCommands = $state<SlashCommand[]>([]);
  let slashOpen = $state(false);
  let slashQuery = $state("");
  let slashIndex = $state(0);
  const slashMatches = $derived(slashOpen ? filterCommands(allCommands, slashQuery) : []);

  // Steer chips ignore inSteerBar by design (every steer shows here), but still
  // gate on repo binding — universal steers always show, bound ones only for a
  // matching repo.
  const availableSteers = $derived(
    steers.list.filter((s) => steerAppliesToRepo(s, repos.nameFor(repoPath))),
  );

  // Load the slash-command list for this session's repo (its own
  // .claude/commands + .claude/skills layer on top of the global/user ones).
  $effect(() => {
    const rp = repoPath;
    if (!rp) {
      allCommands = [];
      return;
    }
    getCommands(rp)
      .then((r) => {
        if (rp === repoPath) allCommands = r.commands;
      })
      .catch(() => {
        if (rp === repoPath) allCommands = [];
      });
  });

  // Open/refresh the menu from the caret, or close it once the text before the
  // caret is no longer a leading `/token`.
  function refreshSlash() {
    const caret = ta?.selectionStart ?? value.length;
    const trigger = matchSlashTrigger(value, caret);
    if (trigger) {
      slashOpen = true;
      slashQuery = trigger.query;
      slashIndex = 0;
    } else {
      slashOpen = false;
    }
  }

  // Replace the typed `/query` token with the chosen command and hoist it to the
  // front — Claude only runs a *leading* slash command, so a command typed mid-text
  // becomes the leading command with the surrounding text as its argument. Caret
  // lands past `/name ` so the user can type arguments straight away.
  function pickCommand(cmd: SlashCommand) {
    const caret = ta?.selectionStart ?? value.length;
    const start = matchSlashTrigger(value, caret)?.start ?? 0;
    const next = applyCommandPick(value, start, caret, cmd.name);
    value = next.value;
    slashOpen = false;
    queueMicrotask(() => {
      autogrow();
      ta?.focus();
      ta?.setSelectionRange(next.caret, next.caret);
    });
  }

  // Canned steers (same presets as the SteerBar) drop into the field as an
  // editable draft rather than firing straight off — the compose sheet is a
  // "compose then Send" surface, so a steer is a starting point you can tweak.
  // Set when empty, append on a new line otherwise so a typed message is kept.
  function applySteer(text: string) {
    value = value.trim() ? value.trimEnd() + "\n" + text : text;
    slashOpen = false;
    queueMicrotask(() => {
      autogrow();
      ta?.focus();
      const end = value.length;
      ta?.setSelectionRange(end, end);
    });
  }

  // Tap-vs-drag for the horizontally-scrolling steer row (mirrors SteerBar): arm
  // on pointerdown, disarm once movement passes slop (a scroll) or the browser
  // takes the gesture, and only insert on a clean tap — so scrolling the row
  // never fires a chip.
  const STEER_SLOP = 10;
  let steerArmed: number | null = null;
  let steerSX = 0;
  let steerSY = 0;
  function steerDown(e: PointerEvent) {
    steerArmed = e.pointerId;
    steerSX = e.clientX;
    steerSY = e.clientY;
  }
  function steerMove(e: PointerEvent) {
    if (steerArmed !== e.pointerId) return;
    if (Math.abs(e.clientX - steerSX) > STEER_SLOP || Math.abs(e.clientY - steerSY) > STEER_SLOP)
      steerArmed = null;
  }
  function steerCancel(e: PointerEvent) {
    if (steerArmed === e.pointerId) steerArmed = null;
  }
  function steerTap(e: PointerEvent, text: string) {
    if (steerArmed !== e.pointerId) return;
    steerArmed = null;
    e.preventDefault();
    applySteer(text);
  }

  // In-browser dictation via the Web Speech API (Chrome/Android, Safari/iOS).
  // This is NOT the iOS keyboard's native dictation mic — no web API can summon
  // that — but it's the standards-based equivalent: transcribes straight into
  // this field. Known gap: WebKit doesn't expose it inside an iOS home-screen
  // PWA (standalone display mode), only in the Safari browser tab. When
  // unsupported the in-overlay mic toggle hides itself and the overlay is a
  // plain type-and-send sheet — so the entry point never becomes a dead end.

  // Minimal SpeechRecognition interface — the W3C Web Speech API types are not
  // yet in TypeScript's built-in lib.dom.d.ts (only the event/result sub-types
  // are), so we declare the constructor/instance shape we actually consume.
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

  const SpeechRec: SpeechRecognitionConstructor | undefined =
    typeof window !== "undefined"
      ? ((window as SpeechWindow).SpeechRecognition ??
        (window as SpeechWindow).webkitSpeechRecognition)
      : undefined;
  let speechSupported = $state(!!SpeechRec);
  let listening = $state(false);
  let recog: SpeechRecognitionInstance | null = null;

  // ── local Whisper voice input (the optional voice-whisper plugin) ──────────────────
  // Server-side transcription: record with MediaRecorder, POST the clip to the plugin, insert
  // the returned text. This is the ONLY mic in an iOS home-screen PWA (no Web Speech there).
  // Detection is memoized once per page load; absent (404) → we keep Web Speech / hide the mic
  // exactly as before. The backend is the optional voice-whisper plugin (issue #76):
  // https://github.com/erwins-enkel/shepherd-plugin-voice-whisper — install it into ~/.shepherd/plugins/.
  let localVoiceAvailable = $state(false);
  let preferLocal = $state(false);
  let transcribing = $state(false);
  let voiceError = $state(false);
  let voiceErrorTimer: ReturnType<typeof setTimeout> | null = null;

  // The client must actually be able to record — MediaRecorder + getUserMedia. Without them a
  // server-available plugin still can't be used from this browser, so treat local as unusable.
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const localUsable = $derived(localVoiceAvailable && recorderSupported);

  // The mic shows whenever *either* engine can run; `useLocal` picks which engine a NEW tap
  // starts — local when Web Speech is absent (iOS PWA) or the plugin asks to be preferred,
  // else the browser's live dictation. It can flip mid-session (getVoiceStatus() resolving
  // after an auto-started dictation), so it must NOT decide how to STOP an in-flight session.
  const micVisible = $derived(speechSupported || localUsable);
  const useLocal = $derived(localUsable && (!speechSupported || preferLocal));

  // Which engine actually owns the live recording, fixed when it starts. tapMic stops THIS one
  // rather than re-reading `useLocal`, so a mid-session flip never strands the active recorder.
  let activeEngine = $state<"web" | "local" | null>(null);

  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  const MAX_RECORD_MS = 60_000; // cap a single clip so a forgotten mic can't record forever

  // ── live interim transcription (progressive read-along) ────────────────────────────
  // While MediaRecorder captures the authoritative clip, we ALSO tap the SAME mic stream via
  // Web Audio, accumulate raw PCM, and every INTERIM_MS post the growing clip — encoded as a WAV,
  // which is valid at every prefix — to the plugin, showing the returned text live in the field.
  // On stop the accurate full-clip transcription replaces it. This is the ONLY way to get
  // read-along on an iOS home-screen PWA: there is no Web Speech, and an iOS MediaRecorder mp4
  // writes its `moov` atom only on stop so it can't be transcribed mid-recording. Everything stays
  // local (the whisper plugin runs on the host), so — unlike a Web-Speech hybrid — nothing leaves
  // the machine. The final MediaRecorder path is untouched, so a browser without Web Audio simply
  // gets no interim and the same batch result as before.
  interface AudioWindow extends Window {
    webkitAudioContext?: typeof AudioContext;
  }
  const AudioCtx: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as AudioWindow).webkitAudioContext)
      : undefined;
  const INTERIM_MS = 2500; // how often to re-transcribe the growing clip for the live preview
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

  // Tap the live mic stream with Web Audio and start the interim-transcription loop. Best-effort:
  // if Web Audio is unavailable or setup throws, we bail quietly and the final clip still runs.
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
      // ScriptProcessor is deprecated in favour of AudioWorklet, but the worklet needs a separately
      // bundled module; ScriptProcessor is the simplest path that also works in an iOS PWA. A 60 s
      // dictation on the main thread is well within its budget.
      audioProc = audioCtx.createScriptProcessor(4096, 1, 1);
      audioProc.onaudioprocess = (e) => {
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // Route through a muted gain into the destination so the processor actually runs, without
      // echoing the mic back to the speakers.
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

  // One interim tick: transcribe the clip captured so far and show it live. Guarded so only one
  // request is ever in flight, and a stale/late response (a newer tick, or one arriving after we
  // stopped) is discarded via the sequence number.
  async function runInterim() {
    if (interimBusy || transcribing || !listening) return;
    if (pcmChunks.length === 0 || pcmRate === 0) return;
    const blob = pcmChunksToWavBlob(pcmChunks, pcmRate);
    interimBusy = true;
    const seq = ++interimSeq;
    try {
      const text = await transcribeAudio(blob, getLocale() === "de" ? "de" : "en");
      if (seq === interimSeq && listening && text)
        value = dictationBase.trim() ? dictationBase.trimEnd() + " " + text.trim() : text.trim();
      queueMicrotask(autogrow);
    } catch {
      // interim is best-effort — a failed/blocked tick is silently skipped; the final clip still runs
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

  // Start recording. Reached two ways, both within the getUserMedia activation window: an
  // in-sheet mic tap, or the ◉ dictate entry (startDictation) auto-starting on mount when local
  // is the engine — getVoiceStatus is memoized/pre-resolved by then, so the auto-start runs in
  // the same turn as the chip tap. `acquiring` guards the getUserMedia await so an auto-start
  // and a fast manual tap can't both open a stream.
  let acquiring = false;
  async function startLocalRecording() {
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
      // MediaRecorder construction or start() can throw (unsupported mimeType, hardware in use);
      // release the just-acquired mic stream so it isn't left open on failure.
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
      recordTimer = setTimeout(() => stopLocalRecording(), MAX_RECORD_MS);
      // Start the live read-along preview off the same stream (best-effort; the final clip above
      // is authoritative and runs regardless of whether interim capture succeeds).
      dictationBase = value;
      if (mediaStream) startInterimCapture(mediaStream);
    } finally {
      acquiring = false;
    }
  }

  // User-initiated stop → let onstop fire finishLocalRecording (which uploads + inserts).
  function stopLocalRecording() {
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
      const text = await transcribeAudio(blob, getLocale() === "de" ? "de" : "en");
      // The accurate full-clip result replaces whatever the live preview last showed. On error we
      // keep the last interim text rather than discarding what the user just dictated.
      value = dictationBase;
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

  // Append transcribed text after whatever is already in the field (same join rule dictation uses).
  function appendTranscript(text: string) {
    const t = text.trim();
    if (!t) return;
    value = value.trim() ? value.trimEnd() + " " + t : t;
    queueMicrotask(autogrow);
  }

  function toggleDictation() {
    if (!SpeechRec) return;
    if (listening) {
      recog?.stop();
      return;
    }
    recog = new SpeechRec();
    recog.lang = getLocale() === "de" ? "de-DE" : "en-US";
    recog.interimResults = true;
    recog.continuous = true;
    let base = value; // text already typed before dictation started
    recog.onresult = (e: SpeechRecognitionEvent) => {
      let finalChunk = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) base = (base ? base.trimEnd() + " " : "") + finalChunk.trim();
      value = interim ? (base ? base.trimEnd() + " " : "") + interim.trim() : base;
      queueMicrotask(autogrow);
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

  // Keep the sheet centered in the *visible* viewport — i.e. the area above the
  // soft keyboard — so the field and Send button never hide behind it. The
  // visualViewport shrinks/offsets when the keyboard opens; we mirror it onto
  // the overlay so flex-centering targets the on-screen region, not the full
  // (keyboard-occluded) window.
  function syncViewport() {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || !overlayEl) return;
    overlayEl.style.height = `${vv.height}px`;
    overlayEl.style.transform = `translateY(${vv.offsetTop}px)`;
  }

  onMount(() => {
    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    // focus brings up the keyboard for typing; with the mic entry the user can
    // still edit the transcript inline
    ta?.focus();
    autogrow();
    // Probe for the local-Whisper plugin (memoized once per page load, so this resolves in the
    // same turn as the tap that opened the sheet). When the ◉ dictate entry opened us and local
    // is the engine (e.g. iOS PWA, no Web Speech), start recording now — otherwise a local-only
    // dictate chip would open an idle sheet. The status is pre-resolved by the time the chip is
    // tappable, so getUserMedia is still inside the tap's activation window; a denial just flashes
    // an error and leaves the in-sheet mic. Guarded against double-starting Web Speech below.
    getVoiceStatus()
      .then((s) => {
        localVoiceAvailable = s.available;
        preferLocal = s.preferLocal;
        if (startDictation && useLocal && !listening && !transcribing) void startLocalRecording();
      })
      .catch(() => {});
    // Web Speech "open already listening" — fires synchronously so it's never delayed by the
    // probe. On a local-only client (no Web Speech) this is a no-op and the branch above starts
    // local instead.
    if (startDictation && speechSupported) toggleDictation();
  });

  onDestroy(() => {
    recog?.stop();
    teardownRecording();
    if (voiceErrorTimer) clearTimeout(voiceErrorTimer);
    window.visualViewport?.removeEventListener("resize", syncViewport);
    window.visualViewport?.removeEventListener("scroll", syncViewport);
  });

  // grow with content (1 line → capped by CSS max-height, then scrolls)
  function autogrow() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function submit() {
    recog?.stop();
    teardownRecording();
    slashOpen = false;
    onsend(value);
    value = "";
    onclose();
  }

  function cancel() {
    recog?.stop();
    teardownRecording();
    onclose();
  }

  // insert a literal newline at the caret without submitting — Enter does this
  // on the soft keyboard (which has no Shift+Enter), so multi-line prompts build
  // naturally and Send is the sole submit. Escape dismisses the overlay.
  function insertNewline() {
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const next = insertNewlineAt(value, start, end);
    value = next.value;
    queueMicrotask(() => {
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = next.caret;
      ta.focus();
      autogrow();
    });
  }

  // Enter inserts a newline (Send is the only submit). While the slash menu is
  // open it captures arrows/Enter/Tab/Escape to drive the picker (paired hardware
  // keyboard on a foldable/tablet; a tap on a row works regardless). Escape with
  // no menu open dismisses the whole overlay.
  function onKeydown(e: KeyboardEvent) {
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        return;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatches[slashIndex]!);
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashOpen = false;
        return;
      }
    } else if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      slashOpen = false;
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    insertNewline();
  }

  // pointerdown + preventDefault: fire instantly and never blur the textarea
  // (which would dismiss the mobile soft keyboard), matching ControlBar.
  function tapMic(e: PointerEvent) {
    e.preventDefault();
    if (transcribing) return;
    // A live session is stopped by the engine that STARTED it (not the current `useLocal`,
    // which may have flipped mid-session) — otherwise the active recorder is never stopped.
    if (activeEngine === "local") {
      stopLocalRecording();
    } else if (activeEngine === "web") {
      recog?.stop();
    } else if (useLocal) {
      void startLocalRecording();
    } else {
      toggleDictation();
    }
  }
  function tapSend(e: PointerEvent) {
    e.preventDefault();
    submit();
  }
  // dismiss when tapping the dimmed backdrop, but not when tapping the sheet
  function tapBackdrop(e: PointerEvent) {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div
  class="overlay"
  bind:this={overlayEl}
  role="dialog"
  aria-modal="true"
  aria-label={m.composebar_overlay_aria()}
  tabindex="-1"
  use:dialog={{ onclose: cancel }}
  onpointerdown={tapBackdrop}
>
  <div class="sheet">
    <button
      type="button"
      class="close"
      aria-label={m.common_close()}
      onpointerdown={(e) => {
        e.preventDefault();
        cancel();
      }}>✕</button
    >
    <div class="field-wrap">
      <textarea
        bind:this={ta}
        bind:value
        class="field"
        rows="1"
        inputmode="text"
        enterkeyhint="enter"
        autocapitalize="sentences"
        autocomplete="on"
        spellcheck="true"
        data-1p-ignore
        placeholder={m.composebar_placeholder()}
        aria-label={m.composebar_input_aria()}
        onkeydown={onKeydown}
        oninput={() => {
          autogrow();
          refreshSlash();
        }}
        onblur={() => (slashOpen = false)}></textarea>
      {#if slashOpen}
        <SlashCommandMenu
          commands={slashMatches}
          activeIndex={slashIndex}
          placement="up"
          onpick={pickCommand}
          onhover={(i) => (slashIndex = i)}
        />
      {/if}
    </div>
    {#if availableSteers.length > 0}
      <div class="steers">
        {#each availableSteers as s (s.id)}
          <button
            type="button"
            class="steer-chip"
            title={s.text}
            onpointerdown={steerDown}
            onpointermove={steerMove}
            onpointercancel={steerCancel}
            onpointerup={(e) => steerTap(e, s.text)}>{s.label}</button
          >
        {/each}
      </div>
    {/if}
    {#if voiceError}
      <div class="voice-hint" role="alert">{m.composebar_transcribe_failed()}</div>
    {/if}
    <div class="actions">
      {#if micVisible}
        <button
          type="button"
          class="btn mic"
          class:listening
          class:transcribing
          disabled={transcribing}
          aria-label={transcribing
            ? m.composebar_transcribing()
            : listening
              ? m.composebar_dictate_stop_aria()
              : m.composebar_dictate_aria()}
          aria-pressed={listening}
          onpointerdown={tapMic}>{m.composebar_dictate()}</button
        >
      {/if}
      <button
        type="button"
        class="btn send"
        aria-label={m.composebar_send_aria()}
        onpointerdown={tapSend}>{m.composebar_send()}</button
      >
    </div>
  </div>
</div>

<style>
  /* full-screen blurred backdrop — the terminal shimmers through, dimmed, while
     the sheet stays legible. height/transform are set in JS to track the visual
     viewport so the sheet sits flush above the soft keyboard. align-items:flex-end
     anchors the sheet to the bottom edge (a rising bottom sheet), not the center. */
  .overlay {
    position: fixed;
    left: 0;
    top: 0;
    right: 0;
    z-index: 50;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: var(--color-scrim);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }

  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    /* nearly opaque so the composed text reads clearly over the busy terminal */
    background: color-mix(in srgb, var(--color-head) 94%, transparent);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.5);
    /* rise from the bottom edge when summoned */
    animation: sheetRise 0.18s ease-out;
  }
  @keyframes sheetRise {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }

  .close {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 2px;
    color: var(--color-faint);
    font-size: var(--fs-lg);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  .close:active {
    color: var(--color-ink);
    background: var(--color-inset);
  }
  .close:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* anchors the slash-command menu (positioned absolute) to the field */
  .field-wrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
  }

  .field {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 64px; /* starts a touch taller, then autogrows with content */
    max-height: 40vh; /* generous in the overlay, then scroll */
    margin-top: 4px;
    resize: none;
    padding: 10px 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    /* 16px — the iOS no-zoom minimum, so focusing the field never zooms the
       page (kept at the threshold on desktop too for steering legibility) */
    font-size: var(--fs-lg);
    line-height: 1.4;
    overflow-y: auto;
  }
  .field::placeholder {
    color: var(--color-faint);
  }
  .field:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  /* canned-steer row: scrolls horizontally so the presets never crowd the
     field or the Send button; hidden scrollbar like the SteerBar */
  .steers {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    white-space: nowrap;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .steers::-webkit-scrollbar {
    display: none;
  }
  .steer-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    cursor: pointer;
    touch-action: pan-x;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .steer-chip:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .steer-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .actions {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  .btn {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  /* Send is the primary action — full width, weighted */
  .btn.send {
    flex: 1 1 auto;
    background: var(--color-line-bright);
  }
  .btn:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .btn.mic {
    font-size: var(--fs-lg);
    line-height: 1;
  }
  /* while listening/transcribing: highlighted + a soft pulse so it reads as "working" */
  .btn.mic.listening,
  .btn.mic.transcribing {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
    animation: micPulse 1s ease-in-out infinite;
  }
  .btn.mic:disabled {
    cursor: default;
    opacity: 0.7;
  }
  @keyframes micPulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn.mic.listening,
    .btn.mic.transcribing {
      animation: none;
    }
  }

  /* transient error line above the action row when a transcription fails */
  .voice-hint {
    color: var(--color-red);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 0 2px;
  }
</style>
