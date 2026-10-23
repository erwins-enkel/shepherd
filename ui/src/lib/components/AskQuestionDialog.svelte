<script lang="ts">
  import type { PendingAsk, RawAnswer, Session } from "#lib/types.js";
  import { answerAsk } from "#lib/api.js";
  import { askToQuestionForm } from "#lib/askForm.js";
  import { groupAsksByRepo, type AskEntry } from "#lib/ask-center.js";
  import { basename } from "#lib/basename.js";
  import { clock } from "#lib/now.svelte.js";
  import { formatAgo } from "#lib/format.js";
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import { providerLabel } from "#lib/reviewer-env.js";
  import { sessionEnvironment } from "#lib/session-env.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { SvelteSet } from "svelte/reactivity";
  import { m } from "#lib/paraglide/messages.js";
  import QuestionFormBlock from "./blocks/QuestionFormBlock.svelte";

  // The agent's AskUserQuestion dialog as a native form (#3165), grown into a question center: it
  // names the repo, task and session asking, and lists every other session's open question beside
  // it, grouped by repo. The answer is typed into that session's real terminal by the server, which
  // then reports what landed. It closes itself once no open question is left — e.g. the operator
  // answered the last one in the terminal first. The layout is the same for a single question, so
  // answering down to the last one never jumps to a different view.
  let {
    entries,
    focusId,
    onclose,
    onnavigate,
  }: {
    /** Every open question to offer, the focused session's included. */
    entries: AskEntry[];
    /** The session whose question is selected first — the one the Viewport shows. */
    focusId: string;
    onclose: () => void;
    /** Switch to another session; absent hides "Open session". */
    onnavigate?: (id: string) => void;
  } = $props();

  // Questions answered from this dialog: hidden at once instead of waiting for the server's block
  // update to drop them.
  const answered = new SvelteSet<string>();
  const initialFocus = () => focusId;
  let selectedId = $state(initialFocus());

  const focusRepo = $derived(entries.find((e) => e.session.id === focusId)?.session.repoPath);
  const groups = $derived(
    groupAsksByRepo(
      entries.filter((e) => !answered.has(e.ask.toolUseId)),
      focusRepo,
    ),
  );
  const ordered = $derived(groups.flatMap((g) => g.entries));
  const current = $derived(ordered.find((e) => e.session.id === selectedId) ?? ordered[0]);
  const index = $derived(current ? ordered.indexOf(current) : -1);
  const multi = $derived(ordered.length > 1);
  const block = $derived(current ? askToQuestionForm(current.ask) : null);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    onclose();
  }
  $effect(() => {
    if (!current) close();
  });

  const repoIcon = (path: string) => projectIcons.iconFor(path) ?? "▣";
  const agent = (s: Session) => providerLabel(s.agentProvider ?? "claude");
  const waiting = (since: number | undefined) =>
    since === undefined ? null : m.ask_center_waiting({ age: formatAgo(clock.current - since) });
  const firstQuestion = (ask: PendingAsk) => {
    const q = ask.questions[0];
    return q ? [q.header, q.question].filter(Boolean).join(" · ") : "";
  };

  function skip() {
    const next = ordered[(index + 1) % ordered.length];
    if (next) selectedId = next.session.id;
  }

  async function onanswer(answers: RawAnswer[]) {
    // Captured first: hiding the answered entry re-derives `current`.
    const entry = current;
    if (!entry) return;
    const id = entry.session.id;
    const toolUseId = entry.ask.toolUseId;
    // Advance before the request: the next question shows at once, or the dialog closes on the
    // last one. The request outlives a closed dialog.
    const next = ordered[index + 1] ?? ordered[0];
    answered.add(toolUseId);
    if (next && next !== entry) selectedId = next.session.id;
    else close();
    // One keyed toast: "typing…" while the server types + verifies (up to ~10 s), then the verdict.
    const key = `ask:${toolUseId}`;
    toasts.info(m.ask_result_sending(), { key, sticky: true });
    try {
      const result = await answerAsk(id, toolUseId, answers);
      if (result === "verified") toasts.info(m.ask_result_verified(), { key });
      else
        toasts.info(result === "mismatch" ? m.ask_result_mismatch() : m.ask_result_unverified(), {
          key,
          alert: true,
        });
    } catch {
      toasts.info(m.ask_result_failed(), { key, alert: true });
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.ask_center_title()}
    use:dialog={{ onclose: close }}
  >
    <div class="chead">
      <span class="micro">{m.ask_center_title()}</span>
      <span class="count">{ordered.length}</span>
      <button type="button" class="x" onclick={close} aria-label={m.common_close()}>✕</button>
    </div>
    <div class="cbody">
      <nav class="list" aria-label={m.ask_center_title()}>
        {#each groups as g (g.repoPath)}
          <div class="group">
            <span class="glyph" aria-hidden="true">{repoIcon(g.repoPath)}</span>
            <span class="gname">{basename(g.repoPath)}</span>
            <span class="gcount">{g.entries.length}</span>
          </div>
          {#each g.entries as e (e.ask.toolUseId)}
            <button
              type="button"
              class="row"
              aria-current={e === current ? "true" : undefined}
              onclick={() => (selectedId = e.session.id)}
            >
              <span class="rtop">
                <span class="desig">{e.session.desig}</span>
                <span class="rname">{e.session.name}</span>
              </span>
              <span class="rq">{firstQuestion(e.ask)}</span>
              <span class="rmeta">
                {[agent(e.session), waiting(e.since)].filter(Boolean).join(" · ")}
              </span>
            </button>
          {/each}
        {/each}
      </nav>
      {#if current && block}
        {@const s = current.session}
        <div class="detail">
          <div class="ctx">
            <div class="crumb">
              <span class="glyph big" aria-hidden="true">{repoIcon(s.repoPath)}</span>
              <span class="repo">{basename(s.repoPath)}</span>
              <span class="sep" aria-hidden="true">›</span>
              <span class="desig">{s.desig}</span>
              <span class="sep" aria-hidden="true">›</span>
              <span class="name">{s.name}</span>
              {#if onnavigate && s.id !== focusId}
                <button
                  type="button"
                  class="gbtn open"
                  onclick={() => {
                    close();
                    onnavigate(s.id);
                  }}>{m.ask_center_open_session()}</button
                >
              {/if}
            </div>
            <p class="meta">
              {[agent(s), sessionEnvironment(s).model, s.branch, waiting(current.since)]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {#if s.prompt}
              <p class="prompt">
                <span class="plabel">{m.ask_center_prompt_label()}</span>
                <span class="ptext">{s.prompt}</span>
              </p>
            {/if}
          </div>
          <p class="hint">{m.ask_center_hint({ task: s.desig })}</p>
          {#key current.ask.toolUseId}
            <QuestionFormBlock
              {block}
              {onanswer}
              submitLabel={multi ? m.ask_center_submit_next() : m.ask_center_submit()}
            />
          {/key}
          <div class="foot">
            <span class="pos"
              >{m.ask_center_position({ index: index + 1, count: ordered.length })}</span
            >
            <button type="button" class="gbtn" disabled={!multi} onclick={skip}
              >{m.ask_center_skip()}</button
            >
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    width: min(1040px, 94vw);
    height: min(720px, 90dvh);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  .count {
    font-size: var(--fs-meta);
    font-weight: 700;
    padding: 0 6px;
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .cbody {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .list {
    flex: 0 0 300px;
    overflow-y: auto;
    padding: 6px 0;
    border-right: 1px solid var(--color-line);
    background: var(--color-panel-2);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 6px;
  }
  .gname {
    font-weight: 700;
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gcount {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 10px 14px 10px 38px;
    background: transparent;
    border: 0;
    border-top: 1px solid transparent;
    border-bottom: 1px solid transparent;
    color: var(--color-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--color-hover);
  }
  .row[aria-current="true"] {
    background: var(--color-sel);
    border-color: var(--color-line-bright);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .rtop {
    display: flex;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
  }
  .rtop .desig {
    flex: none;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .row[aria-current="true"] .desig {
    color: var(--color-amber);
  }
  .rname,
  .rq {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rname {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  .rq,
  .rmeta {
    font-size: var(--fs-meta);
  }
  .rmeta {
    color: var(--color-muted);
  }
  .detail {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ctx {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .crumb {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 10px;
  }
  .glyph {
    flex: none;
    color: var(--color-muted);
  }
  .glyph.big {
    font-size: var(--fs-xl);
    align-self: center;
  }
  .repo {
    font-size: var(--fs-xl);
    font-weight: 700;
    color: var(--color-ink-bright);
  }
  .sep {
    font-size: var(--fs-lg);
    color: var(--color-muted);
  }
  .crumb .desig {
    font-size: var(--fs-lg);
    color: var(--color-amber);
  }
  .name {
    font-size: var(--fs-lg);
    font-weight: 500;
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .open {
    margin-left: auto;
    align-self: center;
  }
  .meta,
  .prompt,
  .hint {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .prompt {
    display: flex;
    gap: 10px;
    min-width: 0;
  }
  .plabel {
    flex: none;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .ptext {
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--color-line);
  }
  .pos {
    flex: 1;
    font-size: var(--fs-meta);
    color: var(--color-muted);
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
  @media (pointer: coarse) {
    .gbtn {
      min-height: 44px;
    }
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
    }
    .cbody {
      flex-direction: column;
    }
    .list {
      flex: none;
      max-height: 35dvh;
      border-right: 0;
      border-bottom: 1px solid var(--color-line);
    }
  }
</style>
