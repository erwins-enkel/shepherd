<script lang="ts">
  import { getForgeReadiness, applyForgeCheck } from "#lib/api.js";
  import type { ForgeCheck, ForgeCheckId, ForgeReadiness } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import { SvelteSet } from "svelte/reactivity";
  import { applyKey, formatValue } from "./readiness-forge-view";

  let { repoPath }: { repoPath: string } = $props();

  let data = $state.raw<ForgeReadiness | null>(null);
  let loading = $state(true);
  let loadError = $state(false);
  /** In-flight Apply per repo + check (see applyKey). */
  const applying = new SvelteSet<string>();

  // Reload on repo change; drop a stale response that lands after a switch.
  $effect(() => {
    const rp = repoPath;
    loading = true;
    loadError = false;
    data = null;
    getForgeReadiness(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        data = r;
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath) return;
        loadError = true;
        loading = false;
      });
  });

  // Explicit switches (not dynamic m[`…${id}`]) keep the keys statically analysable.
  function title(id: ForgeCheckId): string {
    switch (id) {
      case "merge_methods":
        return m.readiness_forge_merge_methods();
      case "auto_merge":
        return m.readiness_forge_auto_merge();
      case "delete_branch_on_merge":
        return m.readiness_forge_delete_branch();
      case "required_checks":
        return m.readiness_forge_required_checks();
      case "auto_label":
        return m.readiness_forge_auto_label({ label: data?.supported ? data.autoLabel : "" });
    }
  }

  function hint(c: ForgeCheck): string | null {
    if (c.state === "unknown") return m.readiness_forge_hint_unknown();
    switch (c.reason) {
      case "no_admin":
        return m.readiness_forge_hint_no_admin();
      case "no_push":
        return m.readiness_forge_hint_no_push();
      case "no_ci":
        return m.readiness_forge_hint_no_ci();
      case "plan":
        return m.readiness_forge_hint_plan();
      default:
        return null;
    }
  }

  const words = () => ({
    on: m.readiness_forge_on(),
    off: m.readiness_forge_off(),
    none: m.readiness_forge_none(),
    unknown: m.readiness_forge_unknown(),
  });

  async function apply(id: ForgeCheckId) {
    const rp = repoPath;
    const key = applyKey(rp, id);
    if (applying.has(key)) return;
    applying.add(key);
    try {
      const next = await applyForgeCheck(rp, id);
      if (rp !== repoPath) return;
      data = next;
      const after = next.supported ? next.checks.find((c) => c.id === id) : undefined;
      // The re-check decides the outcome: a host that accepted the write but still reports the
      // old value is not "applied".
      if (after?.state === "ok") {
        toasts.info(m.readiness_forge_applied({ check: title(id) }), {
          key: "readiness-forge-applied",
        });
      } else {
        // The write went through but GitHub kept the old value — on a private repo that is
        // usually a plan limit, not a permissions problem.
        toasts.info(m.readiness_forge_apply_ignored(), {
          alert: true,
          key: "readiness-forge-fail",
        });
      }
    } catch {
      if (rp !== repoPath) return;
      toasts.info(m.readiness_forge_apply_error(), { alert: true, key: "readiness-forge-fail" });
    } finally {
      applying.delete(key);
    }
  }
</script>

<div class="section" use:coachTarget={"readiness-forge"}>
  <div class="section-head">{m.readiness_forge_heading()}</div>
  {#if loading}
    <div class="note">{m.common_loading()}</div>
  {:else if loadError || !data}
    <div class="note error">{m.readiness_forge_load_error()}</div>
  {:else if !data.supported}
    <div class="note">{m.readiness_forge_unsupported()}</div>
  {:else}
    <ul class="list">
      {#each data.checks as c (c.id)}
        {@const h = hint(c)}
        <li class="row">
          <span class="dot {c.state}" aria-hidden="true">{c.state === "ok" ? "●" : "○"}</span>
          <div class="row-body">
            <div class="row-title">{title(c.id)}</div>
            <div class="row-values">
              <span>{m.readiness_forge_current()}: {formatValue(c.current, words())}</span>
              {#if c.state !== "ok"}
                <span>{m.readiness_forge_target()}: {formatValue(c.target, words())}</span>
              {/if}
            </div>
            {#if h}<div class="row-hint">{h}</div>{/if}
          </div>
          {#if c.state === "fix"}
            <button
              class="cta"
              type="button"
              disabled={applying.has(applyKey(repoPath, c.id))}
              onclick={() => apply(c.id)}
            >
              {m.readiness_forge_apply()}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .section {
    padding: 12px 0;
  }
  .section-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 8px;
  }
  .note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .note.error {
    color: var(--color-red);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .dot {
    line-height: 1.4;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .dot.ok {
    color: var(--color-green);
  }
  .dot.fix,
  .dot.hint {
    color: var(--color-amber);
  }
  .row-body {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: var(--fs-base);
    color: var(--color-ink);
  }
  .row-values {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    word-break: break-word;
  }
  .row-hint {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    line-height: 1.45;
  }
  .cta {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 9px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .cta:hover {
    background: var(--color-hover);
  }
  .cta:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
