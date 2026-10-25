<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { desigIndex } from "#lib/desigLinks.js";
  import type {
    ActionRequest,
    AnswerAskResult,
    Session,
    PendingAsk,
    RawAnswer,
    SessionMessages,
    SessionStatus,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { answerAsk, getSessionMessages, resolveActionRequest, uploadFile } from "#lib/api.js";
  import { handleImagePaste } from "#lib/clipboard.js";
  import { pollWhileVisible } from "#lib/visibility.js";
  import { clock } from "#lib/activity.js";
  import { chatEntries, unsettled, yesNoQuestions, type PendingSend } from "#lib/assistant-chat.js";
  import { askToQuestionForm } from "#lib/askForm.js";
  import QuestionFormBlock from "./blocks/QuestionFormBlock.svelte";
  import MarkdownBody from "./MarkdownBody.svelte";
  import AttachmentChips, { type Attachment } from "./assistant-chat/AttachmentChips.svelte";
  import AttachButton from "./assistant-chat/AttachButton.svelte";

  // The Operator Assistant's conversation view: the transcript's text messages as a chat, and a
  // composer. Prompt text uses the panel's terminal socket (onsend), including the view report.
  // Structured questions use answerAsk so the server can type and verify their selections.
  let {
    sessionId,
    status,
    herd = [],
    onnavigate,
    ask = null,
    actionRequest = null,
    mobile = false,
    touch = false,
    prefill = null,
    onprefilled,
    consumeAutoFocus,
    onsend,
    oninterrupt,
    onterminal,
  }: {
    sessionId: string;
    status: SessionStatus;
    herd?: readonly Pick<Session, "id" | "desig">[];
    onnavigate?: (id: string) => void;
    ask?: PendingAsk | null;
    /** An action in an `ask` group, held by the server until the operator answers it here. */
    actionRequest?: ActionRequest | null;
    mobile?: boolean;
    touch?: boolean;
    /** An "Ask the assistant" prefill: put into the composer (not sent) for the operator to review. */
    prefill?: { text: string; tick: number } | null;
    onprefilled?: (tick: number) => void;
    /** One-shot: whether the composer may take the keyboard when it mounts. */
    consumeAutoFocus?: () => boolean;
    /** Submit a message at the agent's prompt; false when it could not be sent. */
    onsend: (text: string) => boolean;
    /** Interrupt the agent's turn (Escape). */
    oninterrupt: () => void;
    /** Show the terminal: the agent waits on something only the terminal can answer. */
    onterminal: () => void;
  } = $props();

  /** The newest messages kept in view; older ones stay in the Terminal's scrollback. */
  const LIMIT = 50;
  const POLL_WORKING_MS = 2000;
  const POLL_RESTING_MS = 8000;

  let data = $state<SessionMessages | null>(null);
  let pending = $state<PendingSend[]>([]);
  let draft = $state("");
  let sendFailed = $state(false);
  let thread: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();

  // Images for the next message: each uploads into the assistant's dir at once; Send appends the
  // stored paths to the text so the assistant can Read them.
  let attachments = $state<Attachment[]>([]);
  let nextAttachmentId = 0;
  let dragging = $state(false);

  const herdDesigs = $derived(desigIndex(herd));
  const working = $derived(status === "running");
  const blocked = $derived(status === "blocked");
  let answer = $state<{
    sessionId: string;
    toolUseId: string;
    result: "sending" | AnswerAskResult | "failed";
  } | null>(null);
  // Clearing a question is normal while its request verifies. Keep that result, but discard it
  // when another question or session takes over; late requests must not overwrite the new one.
  $effect(() => {
    const id = sessionId;
    const toolUseId = ask?.toolUseId;
    untrack(() => {
      if (answer && (answer.sessionId !== id || (toolUseId && answer.toolUseId !== toolUseId)))
        answer = null;
    });
  });
  const composerLocked = $derived(!!ask || answer?.result === "sending");
  const uploadingAny = $derived(attachments.some((a) => a.path === null && !a.failed));
  const failedAny = $derived(attachments.some((a) => a.failed));
  const canSend = $derived(
    (!!draft.trim() || attachments.length > 0) && !uploadingAny && !failedAny && !composerLocked,
  );
  const answerText = $derived(
    answer
      ? {
          sending: m.ask_result_sending,
          verified: m.ask_result_verified,
          mismatch: m.ask_result_mismatch,
          unverified: m.ask_result_unverified,
          failed: m.ask_result_failed,
        }[answer.result]()
      : null,
  );
  const answerWarning = $derived(!!answer && !["sending", "verified"].includes(answer.result));

  // The request being answered: "sending" keeps the buttons from firing twice, "failed" says so.
  let decision = $state<{ requestId: string; result: "sending" | "failed" } | null>(null);
  const deciding = $derived(
    actionRequest && decision?.requestId === actionRequest.id ? decision.result : null,
  );

  async function decide(outcome: "approved" | "denied") {
    if (!actionRequest || deciding === "sending") return;
    const requestId = actionRequest.id;
    decision = { requestId, result: "sending" };
    try {
      await resolveActionRequest(sessionId, requestId, outcome);
    } catch {
      if (decision?.requestId === requestId) decision = { requestId, result: "failed" };
    }
  }

  async function submitAnswer(answers: RawAnswer[]) {
    if (!ask || (answer?.sessionId === sessionId && answer.toolUseId === ask.toolUseId)) return;
    answer = { sessionId, toolUseId: ask.toolUseId, result: "sending" };
    const request = answer;
    try {
      const result = await answerAsk(request.sessionId, request.toolUseId, answers);
      if (answer === request) request.result = result;
    } catch {
      if (answer === request) request.result = "failed";
    }
  }

  const entries = $derived(chatEntries(data?.messages ?? []));
  const waiting = $derived(unsettled(pending, entries));
  // Stable keys so a new message doesn't re-render (and re-parse) every row above it.
  const rows = $derived.by(() => {
    const seen: Record<string, number> = {};
    return entries.map((e) => {
      const base = `${e.kind}:${e.ts}`;
      const n = seen[base] ?? 0;
      seen[base] = n + 1;
      return { ...e, key: `${base}:${n}` };
    });
  });

  const latest = $derived(rows.filter((row) => row.kind !== "event").at(-1));
  // Key the local choices to the exact question, including session and streamed text changes.
  const questionKey = $derived(
    latest?.kind === "assistant" ? JSON.stringify([sessionId, latest.key, latest.text]) : "",
  );
  const questions = $derived(yesNoQuestions(latest?.kind === "assistant" ? latest.text : ""));
  let choices = $state<{ key: string; answers: Record<number, string> }>({ key: "", answers: {} });
  let answeredKey = $state("");
  const answers = $derived(choices.key === questionKey ? choices.answers : {});
  // A structured question (#3222) is answered through its own form, never these text replies.
  const showReplies = $derived(
    !working &&
      !blocked &&
      !composerLocked &&
      waiting.length === 0 &&
      questionKey !== answeredKey &&
      questions.length > 0,
  );

  $effect(() => {
    const key = questionKey;
    if (untrack(() => choices.key) !== key) choices = { key, answers: {} };
  });

  function quickReply(index: number, value: string) {
    if (!showReplies) return;
    if (questions.length === 1) {
      if (send(value)) answeredKey = questionKey;
    } else {
      choices = { key: questionKey, answers: { ...answers, [index]: value } };
    }
  }

  function sendAnswers() {
    if (!showReplies || !questions.every((_, i) => answers[i])) return;
    const text = questions.map((q, i) => `${q.number}. ${answers[i]}`).join("\n");
    if (send(text)) answeredKey = questionKey;
  }

  // Poll faster while the agent works; a status change re-runs this and loads at once.
  let stick = true;
  let loadedFor = "";
  $effect(() => {
    const id = sessionId;
    const ms = working ? POLL_WORKING_MS : POLL_RESTING_MS;
    if (id !== loadedFor) {
      loadedFor = id;
      stick = true;
      data = null;
      pending = [];
      untrack(() => (attachments = []));
    }
    let alive = true;
    const load = () =>
      getSessionMessages(id, LIMIT)
        .then((r) => {
          if (alive) data = r;
        })
        .catch(() => {});
    load();
    const stop = pollWhileVisible(load, ms);
    return () => {
      alive = false;
      stop();
    };
  });

  // Follow the conversation while the operator reads its end; leave them where they scrolled to.
  // Watches the content's size rather than the rows: a reply's Markdown renders after the row
  // mounts (lazy marked/DOMPurify), and only then is the end where it will stay.
  let stack: HTMLDivElement | undefined = $state();
  let scrollHeight = 0;
  let clientHeight = 0;
  function onscroll() {
    if (!thread) return;
    // Layout/scroll anchoring can emit a scroll before ResizeObserver follows the new end.
    // Only a scroll within the last measured geometry changes the operator's follow intent.
    if (thread.scrollHeight !== scrollHeight || thread.clientHeight !== clientHeight) return;
    stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
  }
  $effect(() => {
    const el = thread;
    const content = stack;
    // A fresh observer per session: a replacement that reloads to the same height within one
    // frame would otherwise never fire, leaving the old scroll position. `observe()` always
    // reports once, so the new session starts at its end.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    sessionId;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick) el.scrollTop = el.scrollHeight;
      scrollHeight = el.scrollHeight;
      clientHeight = el.clientHeight;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  });

  const MAX_INPUT_PX = 160;
  function autosize() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
  }

  function send(text: string, match?: string): boolean {
    if (!onsend(text)) {
      sendFailed = true;
      return false;
    }
    sendFailed = false;
    pending = [...pending, { text, at: Date.now(), match }];
    stick = true;
    return true;
  }

  function submit() {
    if (!canSend) return;
    const typed = draft.trim();
    const paths = attachments.map((a) => a.path!);
    const text = [typed, paths.join("\n")].filter(Boolean).join("\n\n");
    if (!send(text, paths.length > 0 ? typed : undefined)) return;
    draft = "";
    attachments = [];
    queueMicrotask(autosize);
  }

  function attach(files: Iterable<File>) {
    const id = sessionId;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const a: Attachment = { id: nextAttachmentId++, file, path: null, failed: false };
      attachments = [...attachments, a];
      uploadFile(file, id).then(
        (path) => setAttachment(a.id, { path }),
        () => setAttachment(a.id, { failed: true }),
      );
    }
  }

  // Matched by id: a chip removed (or a session switched) while uploading is not brought back.
  function setAttachment(id: number, patch: Partial<Attachment>) {
    attachments = attachments.map((a) => (a.id === id ? { ...a, ...patch } : a));
  }

  function removeAttachment(id: number) {
    attachments = attachments.filter((a) => a.id !== id);
  }

  function ondrop(e: DragEvent) {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    dragging = false;
    if (!composerLocked) attach(e.dataTransfer.files);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    // Desktop: Enter sends, Shift+Enter breaks the line. Touch keyboards keep Enter for the
    // newline; the Send button sends there.
    if (e.key === "Enter" && !e.shiftKey && !mobile && !touch) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && working) {
      e.preventDefault();
      e.stopPropagation();
      oninterrupt();
    }
  }

  let prefilledTick = -1;
  $effect(() => {
    const req = prefill;
    if (!req || req.tick === prefilledTick) return;
    prefilledTick = req.tick;
    untrack(() => {
      draft = req.text;
      queueMicrotask(autosize);
      if (!mobile && !touch) input?.focus();
      onprefilled?.(req.tick);
    });
  });

  onMount(() => {
    if (consumeAutoFocus?.()) input?.focus();
  });

  /** Hand the keyboard to the composer. */
  export function focus() {
    input?.focus();
  }
</script>

<div class="ac">
  <div
    class="ac-thread"
    bind:this={thread}
    {onscroll}
    role="log"
    aria-label={m.assistant_chat_log()}
  >
    <div class="ac-stack" bind:this={stack}>
      {#if rows.length === 0 && waiting.length === 0 && !working && !ask}
        <p class="ac-empty">{m.assistant_chat_empty()}</p>
      {/if}
      {#each rows as e (e.key)}
        {#if e.kind === "assistant"}
          <div class="ac-msg">
            <MarkdownBody source={e.text} sessionDesigs={herdDesigs} onSessionLink={onnavigate} />
            {#if showReplies && e.key === latest?.key}
              <div class="ac-replies">
                {#each questions as question, i (i)}
                  <div role="group" aria-label={question.text} class="ac-answer">
                    {#if questions.length > 1}<p>{question.number}. {question.text}</p>{/if}
                    <button
                      type="button"
                      class="gbtn"
                      aria-pressed={answers[i] === m.assistant_chat_yes()}
                      onclick={() => quickReply(i, m.assistant_chat_yes())}
                      >{m.assistant_chat_yes()}</button
                    >
                    <button
                      type="button"
                      class="gbtn"
                      aria-pressed={answers[i] === m.assistant_chat_no()}
                      onclick={() => quickReply(i, m.assistant_chat_no())}
                      >{m.assistant_chat_no()}</button
                    >
                  </div>
                {/each}
                {#if questions.length > 1}
                  <button
                    type="button"
                    class="gbtn primary"
                    disabled={!questions.every((_, i) => answers[i])}
                    onclick={sendAnswers}>{m.assistant_chat_send_answers()}</button
                  >
                {/if}
              </div>
            {/if}
            {#if e.ts}<span class="ac-meta">{clock(e.ts)}</span>{/if}
          </div>
        {:else if e.kind === "user"}
          <div class="ac-msg ac-mine">
            <p class="ac-bubble">{e.text}</p>
            <span class="ac-meta"
              >{m.assistant_chat_you()}{#if e.ts}&nbsp;· {clock(e.ts)}{/if}</span
            >
          </div>
        {:else}
          <p class="ac-event">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg
            >
            <span>{e.text}</span>
          </p>
        {/if}
      {/each}
      {#each waiting as p (p.at)}
        <div class="ac-msg ac-mine ac-waiting">
          <p class="ac-bubble">{p.text}</p>
          <span class="ac-meta">{m.assistant_chat_sent()}</span>
        </div>
      {/each}
      {#if working}
        <p class="ac-working" role="status">
          <span class="ac-dot" aria-hidden="true"></span>{m.assistant_chat_working()}
        </p>
      {/if}
      {#if ask}
        {#key `${sessionId}:${ask.toolUseId}`}
          <div class="ac-question">
            <QuestionFormBlock block={askToQuestionForm(ask)} onanswer={submitAnswer} />
          </div>
        {/key}
      {/if}
      {#if actionRequest}
        <div class="ac-notice ac-action" role="alert">
          <p>
            {m.assistant_action_request_title({
              tool: actionRequest.tool,
              target: actionRequest.target,
            })}
          </p>
          {#if Object.keys(actionRequest.args).length > 0}
            <code class="ac-args" aria-label={m.assistant_action_request_args()}
              >{JSON.stringify(actionRequest.args)}</code
            >
          {/if}
          {#if deciding === "failed"}
            <p>{m.assistant_action_request_failed()}</p>
          {/if}
          <div class="ac-actions">
            <button
              type="button"
              class="gbtn"
              disabled={deciding === "sending"}
              onclick={() => decide("denied")}>{m.assistant_action_request_deny()}</button
            >
            <button
              type="button"
              class="gbtn primary"
              disabled={deciding === "sending"}
              onclick={() => decide("approved")}>{m.assistant_action_request_approve()}</button
            >
          </div>
        </div>
      {/if}
      {#if answerText}
        <div class="ac-notice" role={answerWarning ? "alert" : "status"}>
          <p>{answerText}</p>
          {#if answerWarning}
            <button type="button" class="gbtn primary" onclick={onterminal}
              >{m.assistant_chat_open_terminal()}</button
            >
          {/if}
        </div>
      {/if}
      {#if blocked && !ask && !answerWarning && answer?.result !== "sending"}
        <div class="ac-notice" role="status">
          <p>{m.assistant_chat_blocked()}</p>
          <button type="button" class="gbtn primary" onclick={onterminal}
            >{m.assistant_chat_open_terminal()}</button
          >
        </div>
      {/if}
    </div>
  </div>

  <form
    class="ac-composer"
    class:ac-dragging={dragging}
    aria-label={m.assistant_chat_composer()}
    onsubmit={(e) => {
      e.preventDefault();
      submit();
    }}
    ondragover={(e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dragging = false;
    }}
    {ondrop}
  >
    {#if attachments.length > 0}
      <AttachmentChips {attachments} coarse={touch || mobile} onremove={removeAttachment} />
    {/if}
    <div class="ac-field">
      <textarea
        bind:this={input}
        bind:value={draft}
        rows="1"
        aria-label={m.assistant_chat_input_label()}
        placeholder={m.assistant_chat_placeholder()}
        oninput={() => {
          sendFailed = false;
          autosize();
        }}
        onpaste={(e) => {
          if (!composerLocked) handleImagePaste(e, attach);
        }}
        {onkeydown}></textarea>
      <AttachButton disabled={composerLocked} onfiles={attach} />
      {#if working}
        <button type="button" class="gbtn" onclick={oninterrupt}>{m.assistant_chat_stop()}</button>
      {/if}
      <button type="submit" class="gbtn primary" disabled={!canSend}
        >{m.assistant_chat_send()}</button
      >
    </div>
    {#if composerLocked}
      <p class="ac-hint">{m.assistant_chat_answer_question()}</p>
    {:else if failedAny}
      <p class="ac-error" role="alert">{m.assistant_chat_attachment_failed()}</p>
    {:else if sendFailed}
      <p class="ac-error" role="alert">{m.assistant_chat_send_failed()}</p>
    {:else if !mobile && !touch}
      <p class="ac-hint">{m.assistant_chat_keys()}</p>
    {/if}
  </form>
</div>

<style>
  .ac {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .ac-thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 16px 18px;
  }
  /* Pinned to the composer, like a chat, without clipping a long conversation. */
  .ac-stack {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ac-empty {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.55;
  }
  .ac-msg {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .ac-msg :global(.md-body) {
    line-height: 1.65;
  }
  .ac-replies {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .ac-answer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ac-answer p {
    flex-basis: 100%;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .ac-answer .gbtn[aria-pressed="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: var(--color-inset);
  }
  .ac-mine {
    align-self: flex-end;
    align-items: flex-end;
    max-width: 85%;
  }
  .ac-bubble {
    margin: 0;
    padding: 8px 12px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    background: var(--wash-assistant-bubble);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ac-waiting .ac-bubble {
    opacity: 0.7;
  }
  .ac-meta {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }
  .ac-event {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  .ac-event svg {
    flex: none;
    width: 11px;
    height: 11px;
    align-self: center;
  }
  .ac-working {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-amber);
    font-size: var(--fs-meta);
  }
  .ac-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    animation: ac-pulse 1.4s ease-in-out infinite;
  }
  @keyframes ac-pulse {
    50% {
      opacity: 0.3;
    }
  }
  .ac-question {
    padding: 12px;
    border: 1px solid var(--wash-assistant-edge);
    border-radius: var(--radius-chip);
    overflow-wrap: anywhere;
  }
  .ac-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 10px 12px;
    border: 1px solid var(--wash-assistant-edge);
    border-radius: var(--radius-chip);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .ac-args {
    flex-basis: 100%;
    overflow-wrap: anywhere;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .ac-actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .ac-notice p {
    flex: 1;
    min-width: 12em;
    margin: 0;
  }
  .ac-composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border-top: 1px solid var(--color-line);
  }
  .ac-dragging .ac-field {
    border-color: var(--color-amber);
    border-style: dashed;
  }
  .ac-field {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--color-line-bright);
    border-radius: var(--radius-chip);
    background: var(--color-inset);
  }
  .ac-field:focus-within {
    border-color: var(--color-amber);
  }
  .ac-field textarea {
    flex: 1;
    min-width: 0;
    align-self: center;
    padding: 4px 0;
    border: 0;
    outline: none;
    resize: none;
    background: none;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .ac-field textarea::placeholder {
    color: var(--color-muted);
  }
  .ac-hint,
  .ac-error {
    margin: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .ac-hint {
    color: var(--color-muted);
  }
  .ac-error {
    color: var(--color-red);
  }
  /* Button recipe (/design-system .gbtn). */
  .gbtn {
    flex: none;
    min-height: 30px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 10px;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  @media (pointer: coarse) {
    .gbtn {
      min-height: 44px;
    }
  }
</style>
