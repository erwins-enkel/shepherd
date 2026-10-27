<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import { desigIndex } from "#lib/desigLinks.js";
  import type {
    AnswerAskResult,
    BlockReason,
    Session,
    PendingAsk,
    RawAnswer,
    SessionMessages,
    SessionStatus,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { answerAsk, getSessionMessages, uploadFile } from "#lib/api.js";
  import { handleImagePaste } from "#lib/clipboard.js";
  import { pollWhileVisible } from "#lib/visibility.js";
  import { clock } from "#lib/activity.js";
  import {
    assistantChatMessage,
    chatEntries,
    unsettled,
    yesNoQuestions,
    type PendingSend,
  } from "#lib/assistant-chat.js";
  import { blockCard, chatTimeline } from "#lib/chat-timeline.js";
  import { steers } from "#lib/steers.svelte.js";
  import { askToQuestionForm } from "#lib/askForm.js";
  import QuestionFormBlock from "../blocks/QuestionFormBlock.svelte";
  import MarkdownBody from "../MarkdownBody.svelte";
  import AttachmentChips, { type Attachment } from "../assistant-chat/AttachmentChips.svelte";
  import AttachButton from "../assistant-chat/AttachButton.svelte";
  import BlockAnswer from "./BlockAnswer.svelte";
  import ToolRun from "./ToolRun.svelte";
  import NoteRow from "./NoteRow.svelte";
  import QuickReplies from "./QuickReplies.svelte";

  // A session's conversation view, shared by the Operator Assistant and every session's Chat tab:
  // the transcript as a chat (with its tool calls, `tools`), and a composer. Prompt text goes
  // through `onsend` (the terminal socket); a blocked menu or (y/n) prompt is answered with raw
  // keys (`onkeys`). Structured questions use answerAsk so the server can type and verify them.
  let {
    sessionId,
    status,
    variant = "assistant",
    block = null,
    tools = false,
    active = true,
    herd = [],
    onnavigate,
    ask = null,
    notices,
    mobile = false,
    touch = false,
    prefill = null,
    onprefilled,
    consumeAutoFocus,
    onsend,
    onkeys,
    oninterrupt,
    onterminal,
  }: {
    sessionId: string;
    status: SessionStatus;
    /** Whose conversation: the copy names the assistant or the session's agent. */
    variant?: "assistant" | "session";
    /** The session's block reason: a menu or (y/n) prompt gets answer buttons. */
    block?: BlockReason | null;
    /** Show the transcript's tool calls between the messages. */
    tools?: boolean;
    /** Poll the transcript only while the view is on screen. */
    active?: boolean;
    herd?: readonly Pick<Session, "id" | "desig">[];
    onnavigate?: (id: string) => void;
    ask?: PendingAsk | null;
    /** Extra cards under the conversation (the assistant's Action Requests). */
    notices?: Snippet;
    mobile?: boolean;
    touch?: boolean;
    /** An "Ask the assistant" prefill: put into the composer (not sent) for the operator to review. */
    prefill?: { text: string; tick: number } | null;
    onprefilled?: (tick: number) => void;
    /** One-shot: whether the composer may take the keyboard when it mounts. */
    consumeAutoFocus?: () => boolean;
    /** Submit a message at the agent's prompt; false (now or once settled) when it could not be
     *  sent. */
    onsend: (text: string) => boolean | Promise<boolean>;
    /** Type raw keys into the terminal (a blocked prompt's answer); false when not sent. */
    onkeys?: (seq: string) => boolean;
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

  // Images for the next message: each uploads into the assistant's dir at once; Send lists the
  // stored paths after the text (assistantChatMessage) so the assistant can Read them.
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
  const rows = $derived(chatTimeline(entries, tools ? (data?.tools ?? []) : []));
  const lastRow = $derived(rows.at(-1));
  const latest = $derived(
    rows.filter((row) => row.kind === "assistant" || row.kind === "user").at(-1),
  );
  // The block card this prompt gets; an `ask` has its own form.
  const card = $derived(blocked && !ask ? blockCard(block) : null);
  const COPY = {
    assistant: {
      log: m.assistant_chat_log,
      empty: m.assistant_chat_empty,
      blocked: m.assistant_chat_blocked,
      input: m.assistant_chat_input_label,
      placeholder: m.assistant_chat_placeholder,
      sendFailed: m.assistant_chat_send_failed,
    },
    session: {
      log: m.session_chat_log,
      empty: m.session_chat_empty,
      blocked: m.session_chat_blocked,
      input: m.session_chat_input_label,
      placeholder: m.session_chat_placeholder,
      sendFailed: m.session_chat_send_failed,
    },
  };
  const copy = $derived(COPY[variant]);
  // A session's message that is one of the operator's saved steers names its chip.
  const steerByText = $derived(
    variant === "session"
      ? new Map(steers.list.filter((s) => s.inSteerBar).map((s) => [s.text.trim(), s]))
      : null,
  );
  function chipOf(text: string): string | null {
    const s = steerByText?.get(text.trim());
    return s ? [s.emoji, s.label].filter(Boolean).join(" ") : null;
  }
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
    const withTools = tools;
    if (!active) return;
    if (id !== loadedFor) {
      loadedFor = id;
      stick = true;
      data = null;
      pending = [];
      untrack(() => (attachments = []));
    }
    let alive = true;
    const load = () =>
      (withTools ? getSessionMessages(id, LIMIT, { tools: true }) : getSessionMessages(id, LIMIT))
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
    return track(text, onsend(text), match);
  }

  /** Show `text` as sent until the transcript logs it; false when it was not sent. */
  function track(text: string, sent: boolean | Promise<boolean>, match?: string): boolean {
    if (sent === false) {
      sendFailed = true;
      return false;
    }
    sendFailed = false;
    const at = Date.now();
    pending = [...pending, { text, at, match }];
    stick = true;
    // A send that settles later (the reply fallback) takes its echo back when it fails.
    if (sent instanceof Promise) {
      const drop = () => {
        pending = pending.filter((p) => p.at !== at || p.text !== text);
        sendFailed = true;
      };
      sent.then((ok) => ok || drop(), drop);
    }
    return true;
  }

  function submit() {
    if (!canSend) return;
    const typed = draft.trim();
    const paths = attachments.map((a) => a.path!);
    const text = assistantChatMessage(typed, paths);
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

  /** Echo a message sent elsewhere (a steer chip) as sent, dropped again if `sent` fails. */
  export function echo(text: string, sent: Promise<boolean>) {
    track(text, sent);
  }

  /** Hand the keyboard to the composer. */
  export function focus() {
    input?.focus();
  }
</script>

<div class="ac">
  <div class="ac-thread" bind:this={thread} {onscroll} role="log" aria-label={copy.log()}>
    <div class="ac-stack" bind:this={stack}>
      {#if rows.length === 0 && waiting.length === 0 && !working && !ask}
        <p class="ac-empty">{copy.empty()}</p>
      {/if}
      {#each rows as e (e.key)}
        {#if e.kind === "assistant"}
          <div class="ac-msg">
            <MarkdownBody source={e.text} sessionDesigs={herdDesigs} onSessionLink={onnavigate} />
            {#if showReplies && e.key === latest?.key}
              <QuickReplies {questions} {answers} onreply={quickReply} onsendall={sendAnswers} />
            {/if}
            {#if e.ts}<span class="ac-meta">{clock(e.ts)}</span>{/if}
          </div>
        {:else if e.kind === "user"}
          <div class="ac-msg ac-mine">
            <p class="ac-bubble">{e.text}</p>
            <span class="ac-meta"
              >{[m.assistant_chat_you(), chipOf(e.text), e.ts ? clock(e.ts) : null]
                .filter(Boolean)
                .join(" · ")}</span
            >
          </div>
        {:else if e.kind === "tools"}
          <ToolRun calls={e.calls} live={working && e === lastRow} />
        {:else}
          <NoteRow entry={e} />
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
      {#if card && block}
        <BlockAnswer {block} {card} {sessionId} {onkeys} {onterminal} />
      {/if}
      {@render notices?.()}
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
      {#if blocked && !ask && !card && !answerWarning && answer?.result !== "sending"}
        <div class="ac-notice" role="status">
          <p>{copy.blocked()}</p>
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
        aria-label={copy.input()}
        placeholder={copy.placeholder()}
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
      <p class="ac-error" role="alert">{copy.sendFailed()}</p>
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
  .ac :global(.ac-notice) {
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
  .ac :global(.ac-args) {
    flex-basis: 100%;
    overflow-wrap: anywhere;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .ac :global(.ac-actions) {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .ac :global(.ac-notice p) {
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
  /* Button + notice recipes (/design-system .gbtn), shared with the cards rendered inside. */
  .ac :global(.gbtn) {
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
  .ac :global(.gbtn:hover:not(:disabled)) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .ac :global(.gbtn:focus-visible) {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .ac :global(.gbtn:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ac :global(.gbtn.primary) {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  @media (pointer: coarse) {
    .ac :global(.gbtn) {
      min-height: 44px;
    }
  }
</style>
