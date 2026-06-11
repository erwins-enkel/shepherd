<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig, planGates } from "$lib/reviews.svelte";
  import { clampCap, clampCeiling, sanitizeLabel } from "./git-rail-drain";
  import { getRepoRoles, getRepoCollaborators, putRepoRoles } from "$lib/api";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import type { Session, RepoRoles } from "$lib/types";

  let {
    repoPath,
    sessionId,
    planPhase = null,
  }: { repoPath: string; sessionId: string; planPhase?: Session["planPhase"] } = $props();

  const flags = $derived(repoConfig.flags(repoPath));
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const planReviewing = $derived(planGates.isReviewing(sessionId));

  // Which row's long-form "ⓘ" explanation is currently expanded. One at a time —
  // this panel is a narrow popover, so a single open detail keeps it readable.
  let openDetail = $state<string | null>(null);
  const toggleDetail = (id: string) => (openDetail = openDetail === id ? null : id);

  // The panel's switches are repo-level defaults; the plan gate is also a per-task
  // one-shot set at creation. Surface THIS task's actual gate phase so a tick in
  // New Task doesn't read as "off" just because the repo default is off. Shown only
  // when the task is genuinely gated — an ungated task needs no line (the repo-wide
  // subtitle already explains the switch is a default).
  const planGateTaskLabel = $derived(
    planPhase === "planning"
      ? m.automation_plan_gate_task_planning()
      : m.automation_plan_gate_task_executing(),
  );

  // Drain config fields, seeded from stored config and re-seeded whenever the
  // section becomes visible (drain turned on) or the repo changes.
  // svelte-ignore state_referenced_locally
  let drainCap = $state(repoConfig.maxAutoFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainLabel = $state(repoConfig.autoLabelFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainCeiling = $state(repoConfig.usageCeilingFor(repoPath));
  $effect(() => {
    // Re-seed the inputs when the repo changes or the drain section (re)appears.
    // untrack the store reads so committing a field (which writes back to the
    // store) never retriggers this effect and clobbers an in-flight edit.
    const repo = repoPath;
    if (!flags.autoDrain) return;
    untrack(() => {
      drainCap = repoConfig.maxAutoFor(repo);
      drainLabel = repoConfig.autoLabelFor(repo);
      drainCeiling = repoConfig.usageCeilingFor(repo);
    });
  });

  async function commitDrainCap() {
    const n = clampCap(drainCap);
    drainCap = n;
    await repoConfig.setMaxAuto(repoPath, n);
    drainCap = repoConfig.maxAutoFor(repoPath);
  }
  async function commitDrainLabel() {
    const t = sanitizeLabel(drainLabel);
    if (t === null) {
      drainLabel = repoConfig.autoLabelFor(repoPath);
      return;
    }
    drainLabel = t;
    await repoConfig.setAutoLabel(repoPath, t);
    drainLabel = repoConfig.autoLabelFor(repoPath);
  }
  async function commitDrainCeiling() {
    const n = clampCeiling(drainCeiling);
    drainCeiling = n;
    await repoConfig.setUsageCeiling(repoPath, n);
    drainCeiling = repoConfig.usageCeilingFor(repoPath);
  }

  // Repo responsibilities (.shepherd/roles.json): who reviews, who merges. Loaded
  // lazily when the panel mounts / the repo changes — the herd reads the computed
  // handoff off the cached git state, so this fetch is panel-only.
  let roles = $state<RepoRoles>({ reviewer: null, merger: null });
  let me = $state<string | null>(null);
  let collaborators = $state<string[]>([]);
  let collaboratorsUnavailable = $state(false);
  let rolesError = $state<string | null>(null);
  $effect(() => {
    const repo = repoPath;
    rolesError = null;
    void (async () => {
      try {
        const [r, c] = await Promise.all([getRepoRoles(repo), getRepoCollaborators(repo)]);
        if (repo !== repoPath) return; // repo switched mid-flight — drop stale result
        roles = r.roles;
        me = r.me ?? c.me;
        collaborators = c.logins;
        collaboratorsUnavailable = c.collaboratorsUnavailable;
      } catch {
        /* leave defaults; the free-text fallback still lets the user set roles */
      }
    })();
  });

  function normalizeLogin(v: string): string | null {
    const t = v.trim().replace(/^@/, "");
    return t || null;
  }

  // GitHub logins are case-insensitive — fold so a differently-cased stored login
  // isn't treated as a distinct person (duplicate option / wrong "self" match).
  const eqLogin = (a: string | null, b: string | null) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

  // Map a stored login onto the exact casing of its <option> so the dropdown
  // reflects it — a casing-only difference (stored "Kai" vs me/collaborator "kai")
  // would otherwise match no option and fall back to "— anyone / me —".
  function optionValue(value: string | null): string {
    if (!value) return "";
    if (eqLogin(value, me)) return me ?? value;
    return collaborators.find((c) => eqLogin(c, value)) ?? value;
  }

  // The popover is anchored to its trigger (top: 100% on the rail wrapper), so a
  // viewport-relative max-height alone can't keep the bottom on screen — how much
  // room exists depends on where the anchor sits. Measure the anchor and cap the
  // popover's height to the space actually available, so the internal scrollbar
  // engages and the last sections (e.g. Zuständigkeiten) stay reachable. When the
  // anchor sits so low that less than MIN_HEIGHT remains below, flip the popover
  // above the anchor instead of letting a sliver poke past the viewport edge.
  const MIN_HEIGHT = 160; // px — below this a scrollable popover stops being usable
  const EDGE_GAP = 12; // px breathing room to the viewport edge
  const ANCHOR_GAP = 4; // px offset from the anchor (matches the CSS margin)
  let popEl = $state<HTMLDivElement | null>(null);
  let flipUp = $state(false);
  $effect(() => {
    const el = popEl;
    if (!el) return;
    const clamp = () => {
      // Measure the anchor (the positioning wrapper), not the popover itself —
      // the popover's own rect moves when we flip it, the anchor's doesn't.
      const anchor = el.offsetParent;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - ANCHOR_GAP - EDGE_GAP;
      const above = rect.top - ANCHOR_GAP - EDGE_GAP;
      flipUp = below < MIN_HEIGHT && above > below;
      el.style.maxHeight = `${Math.max(MIN_HEIGHT, flipUp ? above : below)}px`;
    };
    // rAF-throttle: the scroll listener is capture-phase on window, so it fires
    // for every scroll anywhere — coalesce to one layout read+write per frame.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clamp();
      });
    };
    clamp();
    window.addEventListener("resize", schedule);
    // capture-phase scroll: the anchor may live inside a scrollable container,
    // and scroll events don't bubble — recompute whenever anything scrolls.
    window.addEventListener("scroll", schedule, true);
    // The anchor can also shift without any scroll/resize — e.g. content above
    // it loading in and growing the wrapper. Watch the wrapper's size directly.
    const ro = new ResizeObserver(schedule);
    if (el.offsetParent) ro.observe(el.offsetParent);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      ro.disconnect();
    };
  });

  async function setRole(role: "reviewer" | "merger", value: string | null) {
    const prev = roles;
    roles = { ...roles, [role]: value }; // optimistic
    rolesError = null;
    try {
      const res = await putRepoRoles(repoPath, { [role]: value });
      if (res.pushError) {
        roles = prev; // push rejected (protected branch / auth) → revert + surface
        rolesError = res.pushError;
        return;
      }
      roles = res.roles;
      if (res.me) me = res.me;
    } catch (e) {
      roles = prev;
      rolesError = String((e as Error)?.message ?? e);
    }
  }
</script>

<div
  class={["auto-pop", { "flip-up": flipUp }]}
  role="dialog"
  aria-label={m.automation_panel_title()}
  bind:this={popEl}
>
  <div class="auto-head">{m.automation_panel_title()}</div>
  <div class="auto-sub">{m.automation_panel_subtitle()}</div>

  <!-- Clickable "ⓘ" that toggles a row's long-form explanation, and the detail
       block it reveals. Reused by every row so each function carries a thorough,
       newcomer-friendly description of what it does, how, and when it fires. -->
  {#snippet info(id: string, name: string)}
    <button
      class={["info", { open: openDetail === id }]}
      type="button"
      aria-expanded={openDetail === id}
      aria-controls="auto-detail-{id}"
      aria-label={m.automation_info_aria({ name })}
      onclick={() => toggleDetail(id)}
    >
      <span aria-hidden="true">i</span>
    </button>
  {/snippet}
  {#snippet detail(id: string, text: string)}
    <!-- always in the DOM so the button's aria-controls target always resolves;
         toggled with `hidden` rather than {#if} for assistive tech -->
    <p id="auto-detail-{id}" class="auto-detail" role="note" hidden={openDetail !== id}>{text}</p>
  {/snippet}

  <!-- Code review -->
  <div class="auto-group">{m.automation_group_review()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">
        ⌕ {m.automation_critic_name()}
        {@render info("critic", m.automation_critic_name())}
      </div>
      <div class="auto-desc">{m.automation_critic_desc()}</div>
      {@render detail("critic", m.automation_critic_detail())}
    </div>
    <button
      class={["sw", { on: flags.critic, reviewing }]}
      type="button"
      role="switch"
      aria-checked={flags.critic}
      aria-busy={reviewing}
      aria-label={m.automation_critic_name()}
      onclick={() => repoConfig.toggle(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class={["auto-row", { disabled: !flags.critic }]}>
    <div class="auto-meta">
      <div class="auto-name">
        ◆ {m.automation_autoaddress_name()}
        {@render info("auto-address", m.automation_autoaddress_name())}
      </div>
      <div class="auto-desc">
        {flags.critic ? m.automation_autoaddress_desc() : m.automation_autoaddress_needs_critic()}
      </div>
      {@render detail("auto-address", m.automation_autoaddress_detail())}
    </div>
    <button
      class={["sw", { on: flags.autoAddress && flags.critic }]}
      type="button"
      role="switch"
      aria-checked={flags.autoAddress && flags.critic}
      disabled={!flags.critic}
      aria-label={m.automation_autoaddress_name()}
      onclick={() => repoConfig.toggleAutoAddress(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">
        ⌖ {m.automation_plan_gate_name()}
        {@render info("plan-gate", m.automation_plan_gate_name())}
      </div>
      <div class="auto-desc">{m.automation_plan_gate_desc()}</div>
      {#if planPhase != null}
        <div class="auto-task">{planGateTaskLabel}</div>
      {/if}
      {@render detail("plan-gate", m.automation_plan_gate_detail())}
    </div>
    <button
      class={["sw", { on: flags.planGate, reviewing: planReviewing }]}
      type="button"
      role="switch"
      aria-checked={flags.planGate}
      aria-busy={planReviewing}
      aria-label={m.automation_plan_gate_name()}
      onclick={() => repoConfig.togglePlanGate(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>

  <!-- Agent behavior -->
  <div class="auto-group">{m.automation_group_behavior()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">
        ✦ {m.automation_learnings_name()}
        {@render info("learnings", m.automation_learnings_name())}
      </div>
      <div class="auto-desc">{m.automation_learnings_desc()}</div>
      {@render detail("learnings", m.automation_learnings_detail())}
    </div>
    <button
      class={["sw", { on: flags.learnings }]}
      type="button"
      role="switch"
      aria-checked={flags.learnings}
      aria-label={m.automation_learnings_name()}
      onclick={() => repoConfig.toggleLearnings(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">
        ▲ {m.automation_autopilot_name()}
        {@render info("autopilot", m.automation_autopilot_name())}
      </div>
      <div class="auto-desc">{m.automation_autopilot_desc()}</div>
      {@render detail("autopilot", m.automation_autopilot_detail())}
    </div>
    <button
      class={["sw", { on: flags.autopilot }]}
      type="button"
      role="switch"
      aria-checked={flags.autopilot}
      aria-label={m.automation_autopilot_name()}
      onclick={() => repoConfig.toggleAutopilot(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>

  <!-- Work queue -->
  <div class="auto-group">{m.automation_group_queue()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">
        ▽ {m.automation_autodrain_name()}
        {@render info("auto-drain", m.automation_autodrain_name())}
      </div>
      <div class="auto-desc">{m.automation_autodrain_desc()}</div>
      {@render detail("auto-drain", m.automation_autodrain_detail())}
    </div>
    <button
      class={["sw", { on: flags.autoDrain }]}
      type="button"
      role="switch"
      aria-checked={flags.autoDrain}
      aria-label={m.automation_autodrain_name()}
      onclick={() => repoConfig.toggleAutoDrain(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class={["auto-row", { disabled: flags.draftMode }]}>
    <div class="auto-meta">
      <div class="auto-name">
        ↣ {m.automation_automerge_name()}
        {@render info("auto-merge", m.automation_automerge_name())}
      </div>
      <div class="auto-desc">
        {flags.draftMode
          ? m.automation_draftmode_excludes_automerge()
          : m.automation_automerge_desc()}
      </div>
      {@render detail("auto-merge", m.automation_automerge_detail())}
    </div>
    <button
      class={["sw", { on: flags.autoMerge && !flags.draftMode }]}
      type="button"
      role="switch"
      aria-checked={flags.autoMerge && !flags.draftMode}
      disabled={flags.draftMode}
      title={flags.draftMode ? m.automation_draftmode_excludes_automerge() : undefined}
      aria-label={m.automation_automerge_name()}
      onclick={() => repoConfig.toggleAutoMerge(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">
        ▦ {m.automation_buildqueue_name()}
        {@render info("build-queue", m.automation_buildqueue_name())}
      </div>
      <div class="auto-desc">{m.automation_buildqueue_desc()}</div>
      {@render detail("build-queue", m.automation_buildqueue_detail())}
    </div>
    <button
      class={["sw", { on: flags.buildQueue }]}
      type="button"
      role="switch"
      aria-checked={flags.buildQueue}
      aria-label={m.automation_buildqueue_name()}
      onclick={() => repoConfig.toggleBuildQueue(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class={["auto-row", { disabled: flags.autoMerge }]} use:coachTarget={"draft-mode"}>
    <div class="auto-meta">
      <div class="auto-name">□ {m.automation_draftmode_name()}</div>
      <div class="auto-desc">
        {flags.autoMerge
          ? m.automation_draftmode_excludes_automerge()
          : m.automation_draftmode_desc()}
      </div>
    </div>
    <button
      class={["sw", { on: flags.draftMode && !flags.autoMerge }]}
      type="button"
      role="switch"
      aria-checked={flags.draftMode && !flags.autoMerge}
      disabled={flags.autoMerge}
      title={flags.autoMerge ? m.automation_draftmode_excludes_automerge() : undefined}
      aria-label={m.automation_draftmode_name()}
      onclick={() => repoConfig.toggleDraftMode(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  {#if flags.draftMode}
    <div class="drain-fields">
      <label class="drain-field">
        <span class="drain-label">{m.automation_signoff_authority_label()}</span>
        <select
          class="num signoff-select"
          aria-label={m.automation_signoff_authority_label()}
          value={repoConfig.signoffAuthorityFor(repoPath)}
          onchange={(e) =>
            repoConfig.setSignoffAuthority(
              repoPath,
              (e.currentTarget as HTMLSelectElement).value as "human" | "critic" | "either",
            )}
        >
          <option value="human">{m.signoff_authority_human()}</option>
          <!-- Critic-reliant authorities are unusable with the Critic off (they could never
               promote a draft → permanent-draft deadlock), so disable them. -->
          <option value="critic" disabled={!flags.critic}>{m.signoff_authority_critic()}</option>
          <option value="either" disabled={!flags.critic}>{m.signoff_authority_either()}</option>
        </select>
      </label>
      {#if !flags.critic}
        <div class="signoff-note">{m.automation_signoff_needs_critic()}</div>
      {/if}
    </div>
  {/if}
  {#if flags.autoDrain}
    <div class="drain-fields">
      <label class="drain-field">
        <span class="drain-label">{m.drain_cap_label()}</span>
        <input
          class="num"
          type="number"
          min="1"
          max="20"
          bind:value={drainCap}
          aria-label={m.drain_cap_label()}
          onchange={commitDrainCap}
        />
      </label>
      <label class="drain-field">
        <span class="drain-label">{m.drain_label_label()}</span>
        <input
          class="num txt"
          type="text"
          bind:value={drainLabel}
          aria-label={m.drain_label_label()}
          onchange={commitDrainLabel}
          onblur={commitDrainLabel}
        />
      </label>
      <label class="drain-field">
        <span class="drain-label">{m.drain_ceiling_label()}</span>
        <input
          class="num"
          type="number"
          min="0"
          max="100"
          bind:value={drainCeiling}
          aria-label={m.drain_ceiling_label()}
          onchange={commitDrainCeiling}
        />
      </label>
    </div>
  {/if}

  <!-- Repo responsibilities: reviewer + merger (committed to .shepherd/roles.json) -->
  <div class="auto-group" id="repo-roles">{m.automation_group_roles()}</div>
  {#snippet roleRow(label: string, role: "reviewer" | "merger", value: string | null)}
    <div class="auto-row">
      <div class="auto-meta">
        <div class="auto-name">{label}</div>
      </div>
      {#if collaboratorsUnavailable}
        <input
          class="role-input"
          type="text"
          placeholder={m.roles_freetext_placeholder()}
          value={value ?? ""}
          aria-label={label}
          onchange={(e) => setRole(role, normalizeLogin(e.currentTarget.value))}
        />
      {:else}
        <select
          class="role-select"
          aria-label={label}
          value={optionValue(value)}
          onchange={(e) => setRole(role, e.currentTarget.value || null)}
        >
          <option value="">{m.roles_unset_option()}</option>
          {#if me}<option value={me}>{m.roles_self_option()} (@{me})</option>{/if}
          {#each collaborators.filter((c) => !eqLogin(c, me)) as login (login)}
            <option value={login}>@{login}</option>
          {/each}
          {#if value && !eqLogin(value, me) && !collaborators.some((c) => eqLogin(c, value))}
            <option {value}>@{value}</option>
          {/if}
        </select>
      {/if}
    </div>
  {/snippet}
  {@render roleRow(m.roles_reviewer_label(), "reviewer", roles.reviewer)}
  {@render roleRow(m.roles_merger_label(), "merger", roles.merger)}
  <div class="roles-note">
    {#if rolesError}
      <span class="roles-err">{m.roles_push_failed()}: {rolesError}</span>
    {:else}
      {m.automation_roles_hint()}
    {/if}
  </div>
</div>

<style>
  /* anchored to the nearest positioned ancestor: GitRail's .git-rail-wrap
     (position: relative) on desktop, or the wider .vp-git-strip on mobile where
     that wrapper goes position:static (see GitRail's .git-rail-wrap.mobile). The
     flip/clamp effect re-measures offsetParent, so either anchor works — but this
     component must still be mounted inside one such positioned ancestor. */
  .auto-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    width: 320px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    /* long-form details can expand a row tall; keep the popover within the
       viewport and scroll instead of overflowing off-screen. The 85vh is only
       the pre-measure fallback — an effect clamps max-height to the space
       actually available below the anchored top edge. */
    max-height: 85vh;
    overflow-y: auto;
  }
  /* anchor too close to the viewport bottom → open upward instead */
  .auto-pop.flip-up {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 4px;
  }
  .auto-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding: 10px 12px 2px;
  }
  .auto-sub {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 0 12px 6px;
  }
  .auto-group {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 8px 12px 4px;
  }
  .auto-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .auto-row.disabled {
    opacity: 0.45;
  }
  .auto-meta {
    min-width: 0;
  }
  .auto-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  /* clickable "ⓘ" — small circular affordance that toggles the long explanation */
  .info {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    padding: 0;
    border: 1px solid var(--color-line);
    border-radius: 50%;
    background: transparent;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    font-style: italic;
    line-height: 1;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .info:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-faint);
  }
  .info.open {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  /* the revealed long-form explanation: a quiet tonal-step note (panel over the
     popover's inset ground) with a full hairline border — no accent stripe */
  .auto-detail {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-ink);
  }
  .auto-desc {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin-top: 2px;
  }
  /* per-task plan-gate reality: amber, shown only when this task is actually gated
     — so a New Task tick reads as active even when the repo default is off */
  .auto-task {
    font-size: var(--fs-micro);
    color: var(--color-amber);
    margin-top: 3px;
  }
  /* switch: track + knob, amber when on (active mode, not a completion —
     Four-Light Rule), pulsing while actively reviewing */
  .sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    /* squared track + knob (2px, instrument hardware) — never pill-shaped */
    border-radius: 2px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .sw:disabled {
    cursor: not-allowed;
  }
  .sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 2px;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .sw.on {
    background: var(--color-amber);
  }
  .sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
  .sw.reviewing {
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: sw-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes sw-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
  .drain-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 12px 22px;
    border-top: 1px solid var(--color-line);
    background: var(--color-panel);
  }
  .drain-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .drain-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    white-space: nowrap;
  }
  .num {
    flex: 0 0 auto;
    width: 90px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 3px 6px;
    text-align: right;
  }
  /* The label is free text (e.g. "shepherd:auto") that overflows the fixed
     numeric width on narrow screens — let it grow with the row and read from
     the start instead of clipping the left side under right-alignment. */
  .num.txt {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    text-align: left;
  }
  .role-select,
  .role-input {
    flex: 0 0 auto;
    width: 140px;
    max-width: 50%;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 3px 6px;
  }
  .roles-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 6px 12px 12px;
  }
  .roles-err {
    color: var(--color-red);
  }
  /* Sign-off authority selector — inherits .num token styling, left-aligned */
  .signoff-select {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    text-align: left;
    cursor: pointer;
    appearance: auto;
  }
  .signoff-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    padding: 0 12px 6px;
  }
</style>
