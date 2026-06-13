<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    getSettings,
    putSettings,
    putRemoteControl,
    putSessionHousekeeping,
    putPrReviewCyclesCap,
    putPlanReviewCyclesCap,
    putDefaultModel,
    putExtraCreditsDrainCeiling,
    listDirs,
    getDiagnostics,
  } from "$lib/api";
  import {
    MODELS,
    PREMIUM_MODELS,
    type DirListing,
    type HerdrUpdateStatus,
    type DiagnosticCheck,
  } from "$lib/types";
  import DiagnoseRows from "$lib/components/DiagnoseRows.svelte";
  import SteersEditor from "$lib/components/SteersEditor.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import {
    pushState,
    enablePush,
    disablePush,
    getPushCategories,
    setPushCategories,
    type PushStatus,
    type PushCategories,
  } from "$lib/push";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import { REPO, REPO_URL, sha, version, commitUrl } from "$lib/build-info";

  // Theme picker — mobile only: the desktop switcher lives in the ActionBar,
  // but on phones the ActionBar hides it and it was dropped from the top bar,
  // so Settings (reachable via the gear from any mobile screen) is its home.
  const THEMES: { pref: ThemePref; icon: "moon" | "sun" | "auto"; label: () => string }[] = [
    { pref: "dark", icon: "moon", label: m.theme_dark },
    { pref: "light", icon: "sun", label: m.theme_light },
    { pref: "system", icon: "auto", label: m.theme_system },
  ];

  // Build/repo facts ($lib/build-info) come from the same source the desktop
  // ActionBar footer uses. That footer is hidden on mobile, so the Device tab is
  // where phone users read them (mirrors the theme picker, surfaced for the same
  // reason).

  // Settings group into three jobs so the modal never outgrows the viewport:
  // WORKSPACE (which repo root), SESSION (how agents start + steer), DEVICE
  // (this browser's notifications + theme). The HERDR-update CTA is an alert,
  // not a section, so it stays pinned above the tab strip.
  const TABS = [
    { id: "workspace", label: m.settings_tab_workspace },
    { id: "session", label: m.settings_tab_session },
    { id: "device", label: m.settings_tab_device },
    { id: "diagnose", label: m.settings_tab_diagnose },
  ] as const;
  type TabId = (typeof TABS)[number]["id"];
  let tabEls: HTMLButtonElement[] = [];

  function onTabKey(e: KeyboardEvent, i: number) {
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    tab = TABS[next].id;
    tabEls[next]?.focus();
  }

  let {
    onclose,
    onsaved,
    onclone,
    herdrUpdate = null,
    onherdrupdate,
    onwhatsnew,
    initialTab = "workspace",
    initialDiagnostics = null,
  }: {
    onclose?: () => void;
    onsaved?: (root: string) => void;
    onclone?: () => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
    onwhatsnew?: () => void;
    initialTab?: TabId;
    /** Pre-seeded diagnostics checks from the store; loaded fresh on tab open if absent. */
    initialDiagnostics?: DiagnosticCheck[] | null;
  } = $props();

  // initialTab seeds the starting tab; the user then freely switches it, so we
  // only ever read the prop once (untrack silences the initial-value warning).
  let tab = $state<TabId>(untrack(() => initialTab));
  let steersEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    if (initialTab === "session") {
      requestAnimationFrame(() => steersEl?.scrollIntoView({ behavior: "auto", block: "start" }));
    }
  });

  // On a phone the HERDR badge folds into the gear; its update flow lands here.
  const herdrUpdateAvailable = $derived(!!herdrUpdate && herdrUpdate.updateAvailable);

  let currentRoot = $state(""); // the persisted root (display form)
  let listing = $state<DirListing | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let push = $state<PushStatus>({ supported: false, permission: "unsupported", subscribed: false });
  let pushBusy = $state(false);
  let categories = $state<PushCategories>({ agent: true, reviews: true, ci: true });

  // Category metadata drives the checkbox list; keys index into `categories`.
  const categoryRows: { key: keyof PushCategories; label: () => string }[] = [
    { key: "agent", label: () => m.settings_push_cat_agent() },
    { key: "reviews", label: () => m.settings_push_cat_reviews() },
    { key: "ci", label: () => m.settings_push_cat_ci() },
  ];
  let remoteControl = $state(false); // Claude Code Remote Control auto-start in sessions
  let rcBusy = $state(false);
  let housekeeping = $state(true); // daily prune of old archived sessions (kill switch)
  let hkBusy = $state(false);
  let retentionDays = $state(30); // display-only, from the settings payload
  let retentionKeep = $state(250); // display-only, from the settings payload
  let prReviewCycles = $state(3); // global max PR-critic auto-address rounds (stepper value)
  let prReviewCyclesMin = $state(1); // bounds from the settings payload (drive min/max)
  let prReviewCyclesMax = $state(8);
  let prReviewCyclesSaved = 3; // last server-confirmed value, for revert on failure
  let prRcyBusy = $state(false);
  let planReviewCycles = $state(5); // global max plan-gate revise rounds (stepper value)
  let planReviewCyclesMin = $state(1); // bounds from the settings payload (drive min/max)
  let planReviewCyclesMax = $state(12);
  let planReviewCyclesSaved = 5; // last server-confirmed value, for revert on failure
  let planRcyBusy = $state(false);
  let defaultModel = $state("auto"); // raw default-model setting (auto|default|<alias>)
  let defaultModelSaved = "auto"; // last server-confirmed value, for revert on failure
  let defaultModelBusy = $state(false);
  const isPremiumModel = $derived(PREMIUM_MODELS.includes(defaultModel));
  let extraCreditsCeiling = $state(0); // account-wide extra-credit spend ceiling (0 = pause on any)
  let extraCreditsCeilingSaved = 0; // last server-confirmed value, for revert on failure
  let extraCreditsBusy = $state(false);

  // Diagnose tab — local checks + re-run state.
  // untrack: initialDiagnostics is intentionally only read once as the seed value.
  let diagChecks = $state<DiagnosticCheck[]>(untrack(() => initialDiagnostics ?? []));
  let diagBusy = $state(false);
  let diagError = $state<string | null>(null);

  async function rerunDiagnostics() {
    if (diagBusy) return;
    diagBusy = true;
    diagError = null;
    try {
      const snap = await getDiagnostics(true);
      diagChecks = snap.checks;
    } catch {
      diagError = "Failed to re-run diagnostics.";
    } finally {
      diagBusy = false;
    }
  }

  async function savePrReviewCycles() {
    if (prRcyBusy) return;
    prRcyBusy = true;
    // Clamp client-side to the server bounds before sending (the server clamps too);
    // an empty/NaN field falls back to the minimum rather than posting garbage.
    const n = Math.round(Number(prReviewCycles));
    const clamped = Number.isFinite(n)
      ? Math.min(prReviewCyclesMax, Math.max(prReviewCyclesMin, n))
      : prReviewCyclesMin;
    prReviewCycles = clamped;
    try {
      const r = await putPrReviewCyclesCap(clamped);
      prReviewCycles = r.prReviewCyclesCap;
      prReviewCyclesSaved = r.prReviewCyclesCap;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      prReviewCycles = prReviewCyclesSaved;
      toasts.info(m.settings_pr_review_cycles_save_failed(), {
        key: "pr-review-cycles-cap",
        duration: null,
        alert: true,
      });
    } finally {
      prRcyBusy = false;
    }
  }

  async function savePlanReviewCycles() {
    if (planRcyBusy) return;
    planRcyBusy = true;
    // Clamp client-side to the server bounds before sending (the server clamps too);
    // an empty/NaN field falls back to the minimum rather than posting garbage.
    const n = Math.round(Number(planReviewCycles));
    const clamped = Number.isFinite(n)
      ? Math.min(planReviewCyclesMax, Math.max(planReviewCyclesMin, n))
      : planReviewCyclesMin;
    planReviewCycles = clamped;
    try {
      const r = await putPlanReviewCyclesCap(clamped);
      planReviewCycles = r.planReviewCyclesCap;
      planReviewCyclesSaved = r.planReviewCyclesCap;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      planReviewCycles = planReviewCyclesSaved;
      toasts.info(m.settings_plan_review_cycles_save_failed(), {
        key: "plan-review-cycles-cap",
        duration: null,
        alert: true,
      });
    } finally {
      planRcyBusy = false;
    }
  }

  async function saveDefaultModel() {
    if (defaultModelBusy) return;
    defaultModelBusy = true;
    try {
      const r = await putDefaultModel(defaultModel);
      defaultModel = r.defaultModel;
      defaultModelSaved = r.defaultModel;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      defaultModel = defaultModelSaved;
      toasts.info(m.settings_default_model_save_failed(), {
        key: "default-model",
        duration: null,
        alert: true,
      });
    } finally {
      defaultModelBusy = false;
    }
  }

  async function saveExtraCreditsCeiling() {
    if (extraCreditsBusy) return;
    extraCreditsBusy = true;
    // Clamp to a non-negative number client-side (the server validates too); an
    // empty/NaN field falls back to 0 rather than posting garbage.
    const n = Number(extraCreditsCeiling);
    const clamped = Number.isFinite(n) && n >= 0 ? n : 0;
    extraCreditsCeiling = clamped;
    try {
      const r = await putExtraCreditsDrainCeiling(clamped);
      extraCreditsCeiling = r.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = r.extraCreditsDrainCeiling;
    } catch {
      // revert to the last server-confirmed value; surface the failure as a persistent,
      // deduped alert so the no-op never looks like a save.
      extraCreditsCeiling = extraCreditsCeilingSaved;
      toasts.info(m.settings_extra_credits_ceiling_save_failed(), {
        key: "extra-credits-ceiling",
        duration: null,
        alert: true,
      });
    } finally {
      extraCreditsBusy = false;
    }
  }

  async function toggleRemoteControl() {
    if (rcBusy) return;
    rcBusy = true;
    const next = !remoteControl;
    try {
      const s = await putRemoteControl(next);
      remoteControl = s.remoteControlAtStartup;
    } finally {
      rcBusy = false;
    }
  }

  async function toggleHousekeeping() {
    if (hkBusy) return;
    hkBusy = true;
    const next = !housekeeping;
    try {
      const s = await putSessionHousekeeping(next);
      housekeeping = s.sessionHousekeepingEnabled;
    } catch {
      // the switch stays in its prior position (state only advances on success);
      // surface the failure so the no-op isn't silent.
      toasts.info(m.settings_housekeeping_save_failed());
    } finally {
      hkBusy = false;
    }
  }

  async function refreshPush() {
    push = await pushState();
    if (push.subscribed) categories = await getPushCategories();
  }

  async function toggleCategory(key: keyof PushCategories) {
    const prev = categories;
    const next = { ...categories, [key]: !categories[key] };
    categories = next; // optimistic; server is authoritative at send time
    if (!(await setPushCategories(next))) categories = prev; // persist failed → revert
  }

  async function togglePush() {
    if (pushBusy) return;
    pushBusy = true;
    try {
      if (push.subscribed) await disablePush();
      else await enablePush();
      await refreshPush();
    } finally {
      pushBusy = false;
    }
  }

  async function browse(path?: string) {
    loading = true;
    error = null;
    try {
      listing = await listDirs(path);
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to list directory";
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await refreshPush();
    try {
      const s = await getSettings();
      currentRoot = s.repoRootDisplay;
      remoteControl = s.remoteControlAtStartup;
      housekeeping = s.sessionHousekeepingEnabled;
      retentionDays = s.sessionRetentionDays;
      retentionKeep = s.sessionRetentionKeep;
      prReviewCyclesMin = s.prReviewCyclesMin;
      prReviewCyclesMax = s.prReviewCyclesMax;
      prReviewCycles = s.prReviewCyclesCap;
      prReviewCyclesSaved = s.prReviewCyclesCap;
      planReviewCyclesMin = s.planReviewCyclesMin;
      planReviewCyclesMax = s.planReviewCyclesMax;
      planReviewCycles = s.planReviewCyclesCap;
      planReviewCyclesSaved = s.planReviewCyclesCap;
      defaultModel = s.defaultModel;
      defaultModelSaved = s.defaultModel;
      extraCreditsCeiling = s.extraCreditsDrainCeiling;
      extraCreditsCeilingSaved = s.extraCreditsDrainCeiling;
      await browse(s.repoRoot);
    } catch {
      await browse();
    }
    // Seed diagnose tab: if no pre-seeded checks from the store, fetch once on mount.
    if (diagChecks.length === 0) {
      try {
        const snap = await getDiagnostics();
        diagChecks = snap.checks;
      } catch {
        // diagnostics unavailable — panel shows empty state gracefully
      }
    }
  });

  const isCurrent = $derived(
    listing != null && currentRoot !== "" && listing.display === currentRoot,
  );

  async function useThisFolder() {
    if (!listing || saving) return;
    saving = true;
    error = null;
    try {
      const s = await putSettings(listing.path);
      currentRoot = s.repoRootDisplay;
      onsaved?.(s.repoRoot);
      onclose?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to save";
      saving = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.settings_title()}
    use:dialog={{ onclose: () => onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.settings_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    {#if herdrUpdateAvailable}
      <button type="button" class="herdr-cta" onclick={() => onherdrupdate?.()}>
        <span class="hc-dot" aria-hidden="true">▲</span>
        <span class="hc-text">
          <span class="hc-label">{m.settings_herdr_update_label()}</span>
          <span class="hc-ver"
            >{m.topbar_herdr_update_title({
              current: herdrUpdate!.current ?? "?",
              latest: herdrUpdate!.latest ?? "?",
            })}</span
          >
        </span>
        <span class="hc-chev" aria-hidden="true">›</span>
      </button>
    {/if}

    <div class="tabs" role="tablist" aria-label={m.settings_tabs_aria()}>
      {#each TABS as t, i (t.id)}
        <button
          type="button"
          role="tab"
          id="settings-tab-{t.id}"
          class="tab"
          class:on={tab === t.id}
          aria-selected={tab === t.id}
          aria-controls="settings-panel-{t.id}"
          tabindex={tab === t.id ? 0 : -1}
          bind:this={tabEls[i]}
          onclick={() => (tab = t.id)}
          onkeydown={(e) => onTabKey(e, i)}>{t.label()}</button
        >
      {/each}
    </div>

    <!-- All three panels stay mounted and toggle via `hidden`: every
         settings-panel-* id resolves for the tabs' aria-controls, and the
         steers editor keeps any in-progress draft across tab switches
         instead of remounting and resyncing from the store. -->
    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-workspace"
      aria-labelledby="settings-tab-workspace"
      tabindex="0"
      hidden={tab !== "workspace"}
    >
      <div class="cur">
        <span class="micro">{m.settings_current_root_label()}</span>
        <code>{currentRoot || "—"}</code>
      </div>

      <span class="micro path-label">{m.settings_browse_label()}</span>
      <div class="crumbs">
        <button
          type="button"
          class="up"
          disabled={!listing?.parent || loading}
          onclick={() => listing?.parent && browse(listing.parent)}
          title={m.settings_up_level()}
        >
          ↑
        </button>
        <code class="here">{listing?.display ?? "…"}</code>
      </div>

      <div class="list">
        {#if loading}
          <div class="placeholder">{m.settings_loading()}</div>
        {:else if listing && listing.entries.length === 0}
          <div class="placeholder">{m.settings_no_subfolders()}</div>
        {:else if listing}
          {#each listing.entries as e (e.path)}
            <button type="button" class="row" onclick={() => browse(e.path)}>
              <span class="ico">▸</span><span class="nm">{e.name}</span>
              <span class="chev">›</span>
            </button>
          {/each}
        {/if}
      </div>

      {#if error}<div class="err">{error}</div>{/if}

      <button
        class="run"
        type="button"
        disabled={!listing || saving || isCurrent}
        onclick={useThisFolder}
      >
        {#if saving}
          {m.settings_saving()}
        {:else if isCurrent}
          {m.settings_already_current()}
        {:else}
          {m.settings_use_folder()}
        {/if}
      </button>
      {#if onclone}
        <button type="button" class="clone-trigger" onclick={() => onclone?.()}
          >{m.clonerepo_trigger()}</button
        >
      {/if}
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-session"
      aria-labelledby="settings-tab-session"
      tabindex="0"
      hidden={tab !== "session"}
    >
      <div class="rc">
        <span class="micro">{m.settings_remote_control_title()}</span>
        <p class="hint">{m.settings_remote_control_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={remoteControl}
          disabled={rcBusy}
          onclick={toggleRemoteControl}
        >
          <span class="track" class:on={remoteControl}><span class="knob"></span></span>
          <span class="state"
            >{remoteControl
              ? m.settings_remote_control_on()
              : m.settings_remote_control_off()}</span
          >
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_housekeeping_title()}</span>
        <p class="hint">
          {m.settings_housekeeping_hint({ days: retentionDays, count: retentionKeep })}
        </p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={housekeeping}
          disabled={hkBusy}
          onclick={toggleHousekeeping}
        >
          <span class="track" class:on={housekeeping}><span class="knob"></span></span>
          <span class="state"
            >{housekeeping ? m.settings_housekeeping_on() : m.settings_housekeeping_off()}</span
          >
        </button>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_pr_review_cycles_title()}</span>
        <p class="hint">
          {m.settings_pr_review_cycles_hint({ min: prReviewCyclesMin, max: prReviewCyclesMax })}
        </p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_review_cycles_label()}</span>
          <input
            class="num"
            type="number"
            min={prReviewCyclesMin}
            max={prReviewCyclesMax}
            step="1"
            disabled={prRcyBusy}
            bind:value={prReviewCycles}
            aria-label={m.settings_pr_review_cycles_title()}
            onchange={savePrReviewCycles}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_plan_review_cycles_title()}</span>
        <p class="hint">
          {m.settings_plan_review_cycles_hint({
            min: planReviewCyclesMin,
            max: planReviewCyclesMax,
          })}
        </p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_review_cycles_label()}</span>
          <input
            class="num"
            type="number"
            min={planReviewCyclesMin}
            max={planReviewCyclesMax}
            step="1"
            disabled={planRcyBusy}
            bind:value={planReviewCycles}
            aria-label={m.settings_plan_review_cycles_title()}
            onchange={savePlanReviewCycles}
          />
        </label>
      </div>
      <div class="rc">
        <span class="micro">{m.settings_default_model_title()}</span>
        <p class="hint">{m.settings_default_model_hint()}</p>
        <select
          class="model-select"
          bind:value={defaultModel}
          disabled={defaultModelBusy}
          aria-label={m.settings_default_model_title()}
          onchange={saveDefaultModel}
        >
          <option value="auto">{m.settings_default_model_auto()}</option>
          <option value="default">{m.newtask_model_default()}</option>
          {#each MODELS as mdl (mdl)}
            <option value={mdl}>{mdl}</option>
          {/each}
        </select>
        {#if isPremiumModel}
          <p class="premium-warn">{m.settings_default_model_premium_warning()}</p>
        {/if}
      </div>
      <div class="rc">
        <span class="micro">{m.settings_extra_credits_ceiling_title()}</span>
        <p class="hint">{m.settings_extra_credits_ceiling_hint()}</p>
        <label class="cycles">
          <span class="cycles-label">{m.settings_extra_credits_ceiling_label()}</span>
          <input
            class="num"
            type="number"
            min="0"
            step="1"
            disabled={extraCreditsBusy}
            bind:value={extraCreditsCeiling}
            aria-label={m.settings_extra_credits_ceiling_title()}
            onchange={saveExtraCreditsCeiling}
          />
        </label>
      </div>
      <div bind:this={steersEl}><SteersEditor /></div>
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-device"
      aria-labelledby="settings-tab-device"
      tabindex="0"
      hidden={tab !== "device"}
    >
      <div class="theme-row">
        <span class="micro">{m.actionbar_theme_group_aria()}</span>
        <div class="theme-seg" role="group" aria-label={m.actionbar_theme_group_aria()}>
          {#each THEMES as t (t.pref)}
            <button
              type="button"
              class="t-opt"
              class:on={theme.pref === t.pref}
              aria-pressed={theme.pref === t.pref}
              aria-label={m.actionbar_theme_option({ label: t.label() })}
              onclick={() => theme.setPref(t.pref)}><ThemeIcon icon={t.icon} /></button
            >
          {/each}
        </div>
      </div>
      <div class="contrast-row">
        <span class="micro">{m.settings_contrast_title()}</span>
        <p class="hint">{m.settings_contrast_hint()}</p>
        <button
          type="button"
          class="toggle"
          role="switch"
          aria-checked={theme.contrast}
          onclick={() => theme.toggleContrast()}
        >
          <span class="track" class:on={theme.contrast}><span class="knob"></span></span>
          <span class="state"
            >{theme.contrast ? m.settings_contrast_on() : m.settings_contrast_off()}</span
          >
        </button>
      </div>
      <div class="push">
        <span class="micro">{m.settings_push_title()}</span>
        {#if !push.supported}
          <p class="hint">{m.settings_push_unsupported()}</p>
        {:else if push.permission === "denied"}
          <p class="hint">{m.settings_push_denied()}</p>
        {:else}
          <button type="button" class="run" disabled={pushBusy} onclick={togglePush}>
            {#if pushBusy}…{:else if push.subscribed}{m.settings_push_disable()}{:else}{m.settings_push_enable()}{/if}
          </button>
          {#if push.subscribed}
            <fieldset class="cats">
              <legend class="micro">{m.settings_push_cat_title()}</legend>
              {#each categoryRows as row (row.key)}
                <label class="cat">
                  <input
                    type="checkbox"
                    checked={categories[row.key]}
                    onchange={() => toggleCategory(row.key)}
                  />
                  <span>{row.label()}</span>
                </label>
              {/each}
            </fieldset>
          {/if}
        {/if}
      </div>
      <div class="about">
        <span class="micro">{m.settings_about_title()}</span>
        <p class="hint">{m.settings_about_blurb()}</p>
        <dl class="about-grid">
          <dt>{m.settings_about_version()}</dt>
          <dd>
            v{version}
            <button type="button" class="clone-trigger whatsnew-btn" onclick={() => onwhatsnew?.()}
              >{m.whatsnew_open()}</button
            >
          </dd>
          <dt>{m.settings_about_commit()}</dt>
          <dd>
            <a
              href={commitUrl}
              target="_blank"
              rel="external noreferrer noopener"
              title={m.actionbar_commit_title({ sha })}>{sha}</a
            >
          </dd>
          <dt>{m.settings_about_repo()}</dt>
          <dd>
            <a
              href={REPO_URL}
              target="_blank"
              rel="external noreferrer noopener"
              title={m.actionbar_repo_link({ repo: REPO })}>{REPO}</a
            >
          </dd>
        </dl>
      </div>
    </div>

    <div
      class="panel"
      role="tabpanel"
      id="settings-panel-diagnose"
      aria-labelledby="settings-tab-diagnose"
      tabindex="0"
      hidden={tab !== "diagnose"}
    >
      <div class="rc">
        <span class="micro">{m.diagnostics_title()}</span>
        <p class="hint">{m.diagnostics_subtitle()}</p>
      </div>
      <DiagnoseRows checks={diagChecks} />
      {#if diagError}
        <p class="hint err">{diagError}</p>
      {/if}
      <button type="button" class="run" disabled={diagBusy} onclick={rerunDiagnostics}>
        {diagBusy ? m.common_loading() : m.diagnostics_rerun()}
      </button>
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
    position: relative;
    width: min(520px, 92vw);
    max-height: 86vh;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  /* Tab strip: muted labels, active marked by amber text + underline (never a
     filled tab). The strip's hairline is the divider; the active tab overlaps
     it with a 2px amber border. */
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--color-line);
  }
  .tab {
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 8px 12px;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--color-ink);
  }
  .tab.on {
    color: var(--color-amber);
    border-bottom-color: var(--color-amber);
  }
  .tab:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
  }
  /* Only the active tab's content lives here; it carries the scroll so a tall
     tab (many steers) stays inside the bounded card instead of overflowing. */
  /* `:not([hidden])` carries `display` so the `hidden` attribute on inactive
     panels still collapses them (author `display` would otherwise beat the UA
     `[hidden] { display: none }`). */
  .panel:not([hidden]) {
    display: flex;
  }
  .panel {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    flex-direction: column;
    gap: 8px;
  }
  /* Keyboard focus on the scrollable tabpanel gets a quiet inset hairline
     rather than no ring at all (it's a tabindex=0 stop). */
  .panel:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -2px;
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
    color: var(--color-muted);
  }
  /* Folded HERDR-update entry point (green, matching the badge it replaces). */
  .herdr-cta {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    border: 1px solid var(--color-green);
    background: color-mix(in srgb, var(--color-green) 12%, transparent);
    border-radius: 2px;
    padding: 10px 12px;
    cursor: pointer;
    font: inherit;
    color: var(--color-ink-bright);
  }
  .herdr-cta .hc-dot {
    color: var(--color-green);
    font-size: var(--fs-micro);
  }
  .herdr-cta .hc-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .herdr-cta .hc-label {
    color: var(--color-green);
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .herdr-cta .hc-ver {
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .herdr-cta .hc-chev {
    color: var(--color-green);
    font-size: var(--fs-xl);
    line-height: 1;
  }
  .cur {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    border-radius: 2px;
  }
  .cur code {
    color: var(--color-amber);
    font-size: var(--fs-base);
    word-break: break-all;
  }
  .path-label {
    margin-top: 4px;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .up {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 5px 9px;
    border-radius: 2px;
    cursor: pointer;
  }
  .up:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .here {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    word-break: break-all;
  }
  .list {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .placeholder {
    padding: 14px 12px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    padding: 9px 11px;
    cursor: pointer;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row:hover {
    background: var(--color-panel);
  }
  .ico {
    opacity: 0.85;
  }
  .nm {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    color: var(--color-faint);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
    margin-top: 2px;
  }
  .run {
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }
  /* Secondary/outline button — same shape as .run but uses the panel's neutral
     line colour rather than amber, so it reads as a lower-priority action. */
  .clone-trigger {
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    background: var(--color-inset);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .clone-trigger:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
  .whatsnew-btn {
    padding: 4px 8px;
    vertical-align: middle;
    margin-left: 6px;
  }
  .push {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .push .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .cats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 0;
    margin: 2px 0 0;
    padding: 0;
  }
  .cats legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .cat {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .cat input {
    cursor: pointer;
  }
  .rc {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rc .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  /* Review-cycles stepper: an inline label + compact number input, mirroring the
     drain-cap control in AutomationPanel. */
  .cycles {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: flex-start;
  }
  .cycles-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  .cycles .num {
    width: 4.5em;
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 6px 8px;
    border-radius: 2px;
    min-height: 36px;
  }
  .cycles .num:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .cycles .num:disabled {
    opacity: 0.5;
  }
  .model-select {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    appearance: none;
    cursor: pointer;
    align-self: flex-start;
  }
  .model-select:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .model-select:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .premium-warn {
    color: var(--color-amber);
    font-size: var(--fs-meta);
    margin: 0;
    font-weight: 500;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 4px 0;
    cursor: pointer;
    font: inherit;
    min-height: 44px;
  }
  .toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .track {
    position: relative;
    width: 38px;
    height: 20px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
    transition: background 0.12s;
  }
  .track.on {
    background: color-mix(in srgb, var(--color-ink) 22%, transparent);
    border-color: var(--color-line-bright);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-muted);
    transition:
      transform 0.12s,
      background 0.12s;
  }
  .track.on .knob {
    transform: translateX(18px);
    background: var(--color-ink-bright);
  }
  .toggle .state {
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
  }
  /* Desktop hosts the theme switcher in the ActionBar; only surface it here on
     mobile, where the ActionBar hides it and the top bar no longer carries it.
     The high-contrast toggle (also ActionBar-only on desktop) rides along — it's
     the readability lift for using the app outdoors / in bright sunlight. */
  .theme-row,
  .contrast-row {
    display: none;
  }
  .contrast-row .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .theme-seg {
    display: flex;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    overflow: hidden;
    align-self: flex-start;
  }
  .t-opt {
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 0 16px;
    min-height: 44px;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
  }
  /* The about blurb shows everywhere; the version / commit / repo rows surface
     only on mobile — desktop reads them from the ActionBar footer. */
  .about {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    border-top: 1px solid var(--color-line);
    padding-top: 12px;
  }
  .about .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .about-grid {
    display: none;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    margin: 0;
  }
  .about-grid dt {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .about-grid dd {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    word-break: break-all;
  }
  .about-grid a {
    color: var(--color-amber);
    text-decoration: none;
  }
  .about-grid a:hover {
    text-decoration: underline;
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .theme-row,
    .contrast-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .about-grid {
      display: grid;
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      max-height: none;
      border: 0;
      overflow: hidden;
    }
    /* Lift the list cap on mobile: the list flexes to fill the bounded panel
       and stays the single scroll region (button pinned below), instead of a
       capped list nested inside a separately-scrolling panel. */
    .list {
      max-height: none;
    }
    .row,
    .up,
    .run {
      min-height: 44px;
    }
  }
</style>
