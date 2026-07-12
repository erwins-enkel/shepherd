<script lang="ts">
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";
  import { replySession } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { fitLabels } from "$lib/fit-labels";
  import { m } from "$lib/paraglide/messages";
  import SteerMenu from "$lib/components/SteerMenu.svelte";
  import ControlBar from "$lib/components/ControlBar.svelte";
  import type { AgentProvider, Steer } from "$lib/types";

  let {
    focusedId,
    repoPath,
    agentProvider = "claude",
    onbroadcast,
    onretry,
    retryHaltedCount = 0,
    retryReady = false,
    onedit,
    mobile = false,
    touch = false,
    termSend = () => {},
    micAvailable = false,
    ondictate = () => {},
  }: {
    focusedId: string;
    repoPath: string;
    agentProvider?: AgentProvider;
    onbroadcast?: () => void;
    onretry?: () => void;
    retryHaltedCount?: number;
    retryReady?: boolean;
    onedit?: (steerId?: string) => void;
    mobile?: boolean;
    touch?: boolean;
    termSend?: (seq: string) => void;
    micAvailable?: boolean;
    ondictate?: () => void;
  } = $props();

  // Only steer-bar-scoped entries render here; issue-scoped ones live on backlog rows.
  // Also gated to steers bound to this session's repo (or universal ones).
  const chips = $derived(
    steers.list.filter(
      (s) => s.inSteerBar && steerAppliesToRepo(s, repos.nameFor(repoPath), agentProvider),
    ),
  );

  // One-time coachmark: the steer chips are tap-to-send — not obvious on first sight.
  // Show a single muted hint until the operator dismisses it, then never again
  // (localStorage). SSR-safe: stays hidden until mount reads the flag.
  const COACH_KEY = "shepherd:steer-coach-seen";
  let showCoach = $state(false);
  $effect(() => {
    try {
      if (localStorage.getItem(COACH_KEY) !== "1") showCoach = true;
    } catch {
      // private mode / blocked storage: skip the hint rather than nag every load
    }
  });
  function dismissCoach() {
    showCoach = false;
    try {
      localStorage.setItem(COACH_KEY, "1");
    } catch {
      // ignore: best-effort persistence
    }
  }

  // Labels toggle: in the cramped mobile bar the emoji chips collapse to icon-only
  // (fitLabels' `compact`), and it's easy to forget what each glyph does. The
  // right-anchored "ABC" key forces every chip's text label back on (overriding
  // compaction) so the operator can read the bar, then collapse it again. Persisted
  // per-device so the choice survives reloads. SSR-safe: stays off until mount.
  const LABELS_KEY = "shepherd:steer-labels";
  let showLabels = $state(false);
  $effect(() => {
    try {
      if (localStorage.getItem(LABELS_KEY) === "1") showLabels = true;
    } catch {
      // private mode / blocked storage: default to icon-only
    }
  });
  function toggleLabels() {
    showLabels = !showLabels;
    try {
      localStorage.setItem(LABELS_KEY, showLabels ? "1" : "0");
    } catch {
      // ignore: best-effort persistence
    }
  }

  // Tap-vs-drag: the bar scrolls horizontally (overflow-x), so a finger that
  // lands on a chip and drags to scroll must NOT fire it. Arm on pointerdown,
  // disarm once the pointer moves past a small slop (it's a scroll) or when the
  // browser takes the gesture over for scrolling (pointercancel), and only act
  // on a clean tap at pointerup. preventDefault on the *up* — not the down —
  // suppresses the synthetic click so the chip never blurs the terminal (which
  // would dismiss the mobile soft keyboard), while leaving native horizontal
  // scrolling intact.
  const TAP_SLOP = 10;
  let armedId: number | null = null;
  let startX = 0;
  let startY = 0;

  function down(e: PointerEvent) {
    // Only a primary (left / touch / pen) press arms a tap. A secondary press is a
    // right-click — the contextmenu handler owns it, so it must not also fire send().
    if (e.button !== 0) return;
    armedId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (armedId !== e.pointerId) return;
    if (Math.abs(e.clientX - startX) > TAP_SLOP || Math.abs(e.clientY - startY) > TAP_SLOP) {
      armedId = null;
    }
  }
  function cancel(e: PointerEvent) {
    if (armedId === e.pointerId) armedId = null;
  }
  function tap(e: PointerEvent, action: () => void) {
    if (armedId !== e.pointerId) return;
    armedId = null;
    e.preventDefault();
    action();
  }

  // Steering is the product's core risky action: a failed send must not vanish.
  // Route the failure through a sticky toast (stays until retried or closed) with
  // an inline Retry (retry re-runs send(), so a repeated
  // failure re-toasts), announced assertively (alert) so a screen-reader
  // operator hears it promptly. Keyed per focused agent so repeated failures
  // collapse into one toast (Retry targets the latest) instead of stacking.
  // Replaces a self-clearing flash easily missed.
  function send(text: string) {
    replySession(focusedId, text).catch(() => {
      toasts.info(m.steerbar_send_failed(), {
        sticky: true,
        alert: true,
        key: `steer-fail:${focusedId}`,
        action: { label: m.common_retry(), run: () => send(text) },
      });
    });
  }

  // Right-click a chip → a small anchored menu offering the two things you might
  // want with a steer: run it (same as a tap) or jump into the editor focused on it.
  // A plain left tap keeps firing send() directly — the menu is the deliberate path.
  let menu = $state<{ steer: Steer; x: number; y: number; opener: HTMLElement } | null>(null);
  function openMenu(e: MouseEvent, s: Steer) {
    e.preventDefault();
    menu = { steer: s, x: e.clientX, y: e.clientY, opener: e.currentTarget as HTMLElement };
  }
</script>

{#if showCoach}
  <div class="coach" data-swipe-ignore>
    <span class="coach-text">{m.steerbar_coach_hint()}</span>
    <!-- No aria-label: the visible "Got it" text is the accessible name, so it
         stays voice-control addressable (WCAG 2.5.3 label-in-name). -->
    <button type="button" class="coach-dismiss" onclick={dismissCoach}
      >{m.steerbar_coach_dismiss()}</button
    >
  </div>
{/if}
<!-- The right-hand slot lives OUTSIDE the scrolling/measured .steer-bar (its flex
     siblings) so neither button enters fitLabels' scrollWidth measurement — an
     in-flow auto-margin would make scrollWidth == clientWidth and poison the cached
     full-label width. The slot holds EITHER the ABC labels toggle (when a label is
     collapsed: bar `compact` or mobile ≤768px) OR the Edit-steers pencil (desktop bar
     where everything fits). They're complementary — exactly one shows, never both —
     and dimensionally identical so the reserved slot width is constant on desktop
     (swapping equal-width buttons never changes .steer-bar's clientWidth, so fitLabels
     can't oscillate). -->
<div class="steer-row" data-swipe-ignore>
  <!-- Esc frozen on the left edge (mobile/touch only) — moved up from the ctrl-row
       so the two mobile bars share the same left anchor. termSend writes the raw
       Esc byte straight to the PTY. -->
  {#if mobile || touch}
    <ControlBar include={["cancel"]} scroll={false} onkey={termSend} />
  {/if}
  <!-- fitLabels toggles `compact` when the full labels overflow: chips that carry an
       emoji collapse to emoji-only (label stays in title/aria); the rest keep their
       label and the bar's horizontal scroll remains the final fallback. -->
  <div
    class="steer-bar"
    class:show-labels={showLabels}
    role="toolbar"
    aria-label={m.steerbar_toolbar_aria()}
    use:fitLabels
  >
    {#if onbroadcast}
      <button
        type="button"
        class="chip bc"
        onpointerdown={down}
        onpointermove={move}
        onpointercancel={cancel}
        onpointerup={(e) => tap(e, onbroadcast)}
        title={m.steerbar_broadcast_aria()}
        aria-label={m.steerbar_broadcast_aria()}
        >⌁<span class="bc-label">{m.steerbar_broadcast()}</span></button
      >
    {/if}
    {#if retryReady && retryHaltedCount > 0}
      <button
        type="button"
        class="chip retry-chip"
        onpointerdown={down}
        onpointermove={move}
        onpointercancel={cancel}
        onpointerup={(e) => tap(e, () => onretry?.())}
        title={m.retry_title()}
        aria-label={m.retry_title()}>⟳<span class="bc-label"> {retryHaltedCount}</span></button
      >
    {/if}
    {#each chips as s (s.id)}
      <button
        type="button"
        class="chip"
        class:has-emoji={!!s.emoji}
        title={s.text}
        aria-label={m.steerbar_send_aria({ label: s.label })}
        oncontextmenu={(e) => openMenu(e, s)}
        onpointerdown={down}
        onpointermove={move}
        onpointercancel={cancel}
        onpointerup={(e) => tap(e, () => send(s.text))}
        >{#if s.emoji}<span class="chip-emoji" aria-hidden="true">{s.emoji}</span>{/if}<span
          class="chip-label">{s.label}</span
        ></button
      >
    {/each}
  </div>
  <!-- Right-anchored labels toggle. Sits at the bar's far right as a flex sibling of
       the scroll area (never scrolls under), shown only when a label is collapsed —
       when the bar collapses (`compact`) or on mobile (≤768px); hidden on a desktop
       bar where everything fits. The accessible name leads with the visible "ABC"
       glyph so voice control can address it by what it reads (WCAG 2.5.3
       label-in-name); the title carries the plain description. -->
  <button
    type="button"
    class="chip lbl-toggle"
    aria-pressed={showLabels}
    title={showLabels ? m.steerbar_labels_hide() : m.steerbar_labels_show()}
    aria-label={m.steerbar_labels_aria({
      action: showLabels ? m.steerbar_labels_hide() : m.steerbar_labels_show(),
    })}
    data-swipe-ignore
    onpointerdown={down}
    onpointermove={move}
    onpointercancel={cancel}
    onpointerup={(e) => tap(e, toggleLabels)}>ABC</button
  >
  <!-- Edit-steers pencil: fills the same right slot when the ABC toggle is hidden
       (desktop bar where everything fits). Pencil-only glyph; the title/aria-label
       carry "Edit steers" (WCAG: a visible label would be a glyph, so the name lives
       in the attributes). Follows .lbl-toggle in source so the `.steer-bar.compact ~`
       general-sibling reveal/hide rules can reach it. Same tap-vs-drag wiring. -->
  <button
    type="button"
    class="chip edit-steers"
    title={m.steerbar_edit()}
    aria-label={m.steerbar_edit()}
    data-swipe-ignore
    onpointerdown={down}
    onpointermove={move}
    onpointercancel={cancel}
    onpointerup={(e) => tap(e, () => onedit?.())}>✎</button
  >
  <!-- Dictate mic: rightmost pinned sibling on mobile/touch when speech capture is
       available. Opens the compose sheet already listening (ondictate). Moved up
       from the ctrl-row so Row 1 owns the mic; Row 2 keeps upload + Enter. -->
  {#if (mobile || touch) && micAvailable}
    <button
      type="button"
      class="dictate"
      title={m.composebar_dictate_aria()}
      aria-label={m.composebar_dictate_aria()}
      onpointerdown={(e) => {
        e.preventDefault();
        ondictate();
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <path d="M12 19v3" />
        <path d="M8 22h8" />
      </svg>
    </button>
  {/if}
</div>

{#if menu}
  <SteerMenu
    x={menu.x}
    y={menu.y}
    label={menu.steer.label}
    opener={menu.opener}
    onrun={() => {
      const text = menu?.steer.text;
      menu = null;
      if (text) send(text);
    }}
    onedit={() => {
      const id = menu?.steer.id;
      menu = null;
      onedit?.(id);
    }}
    onclose={() => (menu = null)}
  />
{/if}

<style>
  /* Row = scrolling chip bar (flex:1) + a right-hand slot holding exactly one of two
     complementary buttons: the ABC toggle (when a label is collapsed / on mobile) or the
     Edit-steers pencil (on a desktop bar where everything fits). Both are sized identically
     so the slot's width is constant whichever shows. Background + top border live here so
     they span the full width including that slot. */
  .steer-row {
    display: flex;
    align-items: stretch;
    min-width: 0;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
  }
  .steer-bar {
    flex: 1 1 auto;
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    overflow-x: auto;
    white-space: nowrap;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .steer-bar::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .chip:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .chip.retry-chip {
    color: var(--color-amber);
    border-color: var(--color-amber);
    opacity: 0.85;
  }
  .bc-label {
    margin-left: 6px;
  }
  .chip-emoji {
    /* operator-set emoji are useful identifiers but full-saturation colour leaks
       outside the controlled palette on the always-present steer bar — desaturate
       modestly so glyphs stay recognizable while the ground stays quiet (Quiet-Ground rule) */
    filter: saturate(0.6);
  }
  .chip-emoji + .chip-label {
    margin-left: 6px;
  }
  /* compact (set by fitLabels on overflow): emoji-carrying chips shed their label —
     the emoji is the identifier; label-only chips are untouched. The retry chip's
     count (`.bc-label`) collapses too, matching its mobile collapse. The
     `:not(.show-labels)` guard lets the ABC toggle force every label back on
     regardless of available width. */
  .steer-bar:global(.compact):not(.show-labels) .chip.has-emoji .chip-label,
  .steer-bar:global(.compact):not(.show-labels) .bc-label {
    display: none;
  }
  .steer-bar:global(.compact):not(.show-labels) .chip.has-emoji {
    min-width: 44px;
    padding: 0;
  }
  /* Labels toggle: a flat "ABC" key at the row's far right, outside the scroll area
     (its own flex column), so it never distorts the chip bar's measured width. Hidden
     by default and revealed only when a label is actually collapsed — when the bar
     collapses (`compact`, rule below) or on mobile (≤768px, media block below); on a
     desktop bar where everything fits it has nothing to reveal, so it stays hidden.
     Margins mirror the bar's padding so it lines up vertically. */
  .lbl-toggle {
    display: none;
    flex: 0 0 auto;
    align-self: center;
    margin: 6px 10px;
    min-width: 44px;
    padding: 0;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    color: var(--color-muted);
  }
  /* Overflow reveal: fitLabels adds `.compact` to .steer-bar when full labels
     overflow. 3 classes (.steer-bar+.compact+.lbl-toggle) outrank the base rule's 1,
     so this wins whenever compact regardless of source order. Independent of
     .show-labels so the toggle stays visible to collapse back once ABC is pressed. */
  .steer-bar:global(.compact) ~ .lbl-toggle {
    display: inline-flex;
  }
  /* Edit-steers: fills the right slot on a desktop bar where everything fits (the
     ABC toggle's complement). Same box as .lbl-toggle so the reserved right slot is
     the same width whichever button shows — fitLabels never sees the channel width
     change, so no compaction oscillation. Pencil-only; the title/aria-label carry
     "Edit steers". Hidden whenever ABC takes the slot: on overflow (.compact) and on
     mobile (≤768px). */
  .edit-steers {
    display: inline-flex;
    flex: 0 0 auto;
    align-self: center;
    margin: 6px 10px;
    min-width: 44px;
    padding: 0;
    font-size: var(--fs-base);
    color: var(--color-muted);
  }
  .steer-bar:global(.compact) ~ .edit-steers {
    display: none;
  }
  .lbl-toggle[aria-pressed="true"] {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
    background: var(--color-hover);
  }
  /* Mobile / short-wide layout (phone portrait+landscape, foldable split-screen). Two
     effects: (1) the retry chip's count (`.bc-label`) collapses to just its ⟳ icon to
     reclaim space, regardless of `compact`; (2) the ABC toggle is surfaced. ABC's job is
     to add `.show-labels`, restoring whatever is collapsed — the retry count here, plus
     emoji chip labels once the bar overflows (`compact`). It's revealed unconditionally
     (NOT gated on something currently being collapsed) so its slot in the pinned right
     cluster — beside the mic — stays put as steers are added or a retry chip appears /
     clears, instead of flickering with the overflow threshold or the async `compact`
     toggle. With only plain-text chips and no retry chip there's nothing to expand and
     the toggle is inert — a harmless, uncommon edge (emoji steer bars overflow → compact,
     where ABC is meaningful). The reveal is viewport-only (1 class, so it ties the base
     `display: none` and wins by source order), independent of `.show-labels` so the
     toggle stays visible to collapse back. The (max-height: 600px) arm keeps this
     consistent on short-wide viewports wider than the 768px breakpoint. */
  @media (max-width: 768px), (max-height: 600px) {
    .steer-bar:not(.show-labels) .bc-label {
      display: none;
    }
    .lbl-toggle {
      display: inline-flex;
    }
    .edit-steers {
      display: none;
    }
  }
  /* Dictate mic — rightmost pinned action on the mobile steer row. Its right edge
     aligns above Enter's on Row 2 (both 10px from the bar edge). */
  .dictate {
    flex: 0 0 auto;
    align-self: center;
    margin: 6px 10px 6px 0;
    min-width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .dictate:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .dictate svg {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
  }
  /* one-time steer hint: flat, square, hairline-bordered, muted ink — sits
     directly above the steer row, no shadow or glow at rest */
  .coach {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.35;
  }
  .coach-text {
    flex: 1 1 auto;
    min-width: 0;
    /* full instructional sentence, not chrome — body size, not the 11px label rung */
    font-size: var(--fs-base);
  }
  .coach-dismiss {
    flex: 0 0 auto;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    cursor: pointer;
    touch-action: manipulation;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .coach-dismiss:hover {
    background: var(--color-hover);
  }
  .coach-dismiss:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .coach-dismiss:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
