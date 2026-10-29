<script lang="ts">
  import type {
    ActionRequest,
    BlockReason,
    Session,
    PendingAsk,
    SessionStatus,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { resolveActionRequest } from "#lib/api.js";
  import ChatView from "./chat/ChatView.svelte";

  // The Operator Assistant's conversation view: the shared ChatView (text messages only), plus the
  // assistant's own Action Requests. Prompt text uses the panel's terminal socket (onsend),
  // including the view report.
  let {
    sessionId,
    status,
    block = null,
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
    onkeys,
    oninterrupt,
    onterminal,
  }: {
    sessionId: string;
    status: SessionStatus;
    /** The assistant session's block reason: a menu or (y/n) prompt gets answer buttons. */
    block?: BlockReason | null;
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
    onsend: (text: string) => boolean | Promise<boolean>;
    /** Type raw keys into the terminal (a blocked prompt's answer); false when not sent. */
    onkeys?: (seq: string) => boolean;
    /** Interrupt the agent's turn (Escape). */
    oninterrupt: () => void;
    /** Show the terminal: the agent waits on something only the terminal can answer. */
    onterminal: () => void;
  } = $props();

  let view: ChatView | undefined = $state();

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

  /** Hand the keyboard to the composer. */
  export function focus() {
    view?.focus();
  }
</script>

<ChatView
  bind:this={view}
  {sessionId}
  {status}
  {block}
  {herd}
  {onnavigate}
  {ask}
  {mobile}
  {touch}
  {prefill}
  {onprefilled}
  {consumeAutoFocus}
  {onsend}
  {onkeys}
  {oninterrupt}
  {onterminal}
>
  {#snippet notices()}
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
  {/snippet}
</ChatView>
