import type { AgentProvider, UpNextItem } from "./types";
import type { HerdStore } from "./store.svelte";
import { startUpNext, type UpNextStartChoice } from "./api";
import { toasts } from "./toasts.svelte";
import { clock } from "./now.svelte";
import { m } from "./paraglide/messages";
import {
  capacitySuggestedProvider,
  claudeUsageHoldLikely,
  readyAgentProviders,
} from "./provider-capacity";
import { upNextKey, upNextUi } from "./up-next-ui.svelte";

/** What starting Up Next work needs from the page: provider capacity and the CLI-picker
 *  settings. Threaded from +page (via Herd for the rail panel). */
export type UpNextLaunchContext = {
  store: Pick<HerdStore, "diagnostics" | "usageLimits">;
  defaultAgentProvider: AgentProvider;
  fableAvailable: boolean;
  upnextSkipCliPicker: boolean;
  usageHoldEnabled: boolean;
  usageHoldPct: number;
  nowMs: number;
};

/** Starts Up Next rows — from the panel's batch bar or the preview's Start. Owns the in-flight
 *  flag and the anchored CLI picker; each surface holds its own starter and renders the picker
 *  through UpNextStartPicker. Started rows leave the shared selection. */
export class UpNextStarter {
  #ctx: () => UpNextLaunchContext | null;
  starting = $state(false);
  picker = $state<{ items: UpNextItem[]; x: number; y: number; opener: HTMLElement } | null>(null);

  constructor(ctx: () => UpNextLaunchContext | null) {
    this.#ctx = ctx;
  }

  // Plain getters over the page context: they stay reactive wherever they are read, and are
  // cheap enough not to need memoizing.
  get usageLimits() {
    return this.#ctx()?.store.usageLimits ?? null;
  }
  get fableAvailable() {
    return this.#ctx()?.fableAvailable ?? true;
  }
  get nowMs() {
    return this.#ctx()?.nowMs ?? clock.current;
  }
  get holdLikely() {
    const ctx = this.#ctx();
    return claudeUsageHoldLikely(
      this.usageLimits,
      ctx?.usageHoldEnabled ?? false,
      ctx?.usageHoldPct ?? 80,
    );
  }
  get suggestedProvider() {
    const ctx = this.#ctx();
    return capacitySuggestedProvider(
      ctx?.defaultAgentProvider ?? "claude",
      ctx?.store.diagnostics ?? null,
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- throwaway lookup arg, never mutated
      new Set<AgentProvider>(this.holdLikely ? ["claude"] : []),
    );
  }

  /** Start now, or open the CLI picker first when more than one provider is ready. */
  request(items: UpNextItem[], opener: HTMLElement) {
    if (this.starting || this.picker || items.length === 0) return;
    const ready = readyAgentProviders(this.#ctx()?.store.diagnostics ?? null);
    if (ready.length >= 2) {
      if (this.#ctx()?.upnextSkipCliPicker ?? false) {
        void this.start(items, { agentProvider: this.suggestedProvider });
        return;
      }
      const r = opener.getBoundingClientRect();
      this.picker = { items, x: r.left, y: r.bottom + 4, opener };
      return;
    }
    if (ready.length === 1) {
      void this.start(items, { agentProvider: ready[0]! });
      return;
    }
    void this.start(items);
  }

  confirmPicker(choice: UpNextStartChoice) {
    const p = this.picker;
    this.picker = null;
    if (!p) return;
    void this.start(p.items, choice);
  }

  async start(items: UpNextItem[], choice?: UpNextStartChoice) {
    if (this.starting || items.length === 0) return;
    this.starting = true;
    try {
      const res = await startUpNext(
        items.map((it) => ({ repoPath: it.repoPath, issueRef: it.issueRef })),
        choice,
      );
      if (res.created.length > 0) {
        toasts.info(m.upnext_started({ count: res.created.length }), { key: "upnext-started" });
      }
      if (res.held.length > 0) {
        toasts.info(m.upnext_held({ count: res.held.length }), { key: "upnext-held" });
      }
      if (res.errors.length > 0) {
        // Failure surfaced as a 12s alert — tone-namespaced dedupe key so repeats collapse.
        toasts.info(m.upnext_start_failed({ count: res.errors.length }), {
          key: "upnext-start-failed",
          alert: true,
        });
      }
      if (res.created.length === 0 && res.held.length === 0 && res.errors.length === 0) {
        toasts.info(m.upnext_start_failed({ count: items.length }), {
          key: "upnext-start-failed",
          alert: true,
        });
      }
      // Clear only the ones we just started; the WS snapshot refresh removes them shortly.
      for (const it of items) upNextUi.selected.delete(upNextKey(it));
    } catch {
      toasts.info(m.upnext_start_failed({ count: items.length }), {
        key: "upnext-start-failed",
        alert: true,
      });
    } finally {
      this.starting = false;
    }
  }
}
