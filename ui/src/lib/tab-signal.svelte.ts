// Ambient browser-tab state signaling (#1327). Fills the "backgrounded-but-open"
// rung of the attention ladder: attended (this tab focused) → no tab signal;
// background → title count + severity-dot favicon + App Badge; away → existing push.
//
// deriveTabState is a PURE function mirroring the in-scope server ATTENTION_RULES
// (src/rundown-core.ts) from the same client-side inputs those rules use — NOT the
// primary-only `store.holds` projection, which would mask ci-red under a co-tier-1
// hold. createTabSignal() owns the side effects (title / <link rel=icon> canvas
// swap / setAppBadge / aria-live) and is driven by one $effect in +page.svelte.

import type { Session, GitState } from "./types";
import { displayStatus } from "./display-status";
import { m } from "$lib/paraglide/messages";

export type Severity = "red" | "amber" | "green" | "none";

export interface TabState {
  /** Count of sessions needing the operator now (blocked · ci-red · ready-to-merge). */
  count: number;
  /** Highest severity across those sessions (red › amber › green › none). */
  severity: Severity;
}

const SEVERITY_RANK: Record<Severity, number> = { none: 0, green: 1, amber: 2, red: 3 };

/** Severity for a single session, or "none" when it needs no operator action.
 *  Mirrors the three in-scope ATTENTION_RULES using their exact inputs:
 *   - ci-red     → git.checks === "failure"            (rundown-core.ts:126)
 *   - blocked    → displayStatus === "blocked"          (blocked-decision, :116)
 *   - ready      → readyToMerge && handoff !== "merger" (ready-merge, :149-151)
 *  Read git.checks directly (not holds) so ci-red is never masked by a co-signal;
 *  read displayStatus so a working-blocked session (mid-turn) is excluded. */
function sessionSeverity(
  s: Session,
  git: GitState | undefined,
  workingBlocked: Record<string, boolean>,
): Severity {
  if (git?.checks === "failure") return "red";
  if (displayStatus(s, workingBlocked) === "blocked") return "amber";
  if (s.readyToMerge && git?.handoff !== "merger") return "green";
  return "none";
}

/** Pure: derive the tab count + highest severity from the store's session/git state. */
export function deriveTabState(
  sessions: Session[],
  git: Record<string, GitState>,
  workingBlocked: Record<string, boolean>,
): TabState {
  let count = 0;
  let severity: Severity = "none";
  for (const s of sessions) {
    const sev = sessionSeverity(s, git[s.id], workingBlocked);
    if (sev === "none") continue;
    count++;
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[severity]) severity = sev;
  }
  return { count, severity };
}

// ── side-effecting controller ────────────────────────────────────────────────

const DEBOUNCE_MS = 400;
const FLOURISH_MS = 2500;

// Last-resort hex fallbacks (mirror app.css dark-theme --red/--amber/--green), used
// only if getComputedStyle returns empty or an unresolved var() string.
const SEVERITY_TOKENS: Record<Exclude<Severity, "none">, [string, string, string]> = {
  red: ["--color-red", "--red", "#e5484d"],
  amber: ["--color-amber", "--amber", "#e8a13a"],
  green: ["--color-green", "--green", "#5ad19a"],
};

/** Resolve a severity color at paint time, guarding the var() chain (review point 8):
 *  semantic token → leaf palette token → safe hex, so canvas fillStyle is always concrete. */
function resolveColor(sev: Exclude<Severity, "none">): string {
  const [semantic, leaf, hex] = SEVERITY_TOKENS[sev];
  const cs = getComputedStyle(document.documentElement);
  for (const name of [semantic, leaf]) {
    const v = cs.getPropertyValue(name).trim();
    if (v && !v.startsWith("var(")) return v;
  }
  return hex;
}

/** Resolve the favicon-ground color (behind the dot) for contrast; safe fallback. */
function groundColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
  return v && !v.startsWith("var(") ? v : "#0a0d0c";
}

class TabSignal {
  #announcement = $state("");
  /** Localized aria-live string, mirrored into a polite region by +page.svelte. */
  get announcement(): string {
    return this.#announcement;
  }

  #initialized = false;
  #baseTitle = "Shepherd";
  #link: HTMLLinkElement | null = null;
  #originalHref = "";
  #originalType = "";
  #baseImg: HTMLImageElement | null = null;

  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #flourishTimer: ReturnType<typeof setTimeout> | null = null;
  #next: { count: number; severity: Severity; attended: boolean } | null = null;
  #lastCount = 0;

  #lazyInit() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#baseTitle = document.title || "Shepherd";
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      this.#link = link;
      // Capture the runtime-resolved href/type (review point 6) so a non-root
      // base/assets path restores the correct default icon — never hardcode a path.
      this.#originalHref = link.href;
      this.#originalType = link.getAttribute("type") ?? "image/svg+xml";
      const img = new Image();
      img.src = this.#originalHref; // preload the base mark for canvas compositing
      this.#baseImg = img;
    }
  }

  /** Debounced entry point, driven by the root $effect. */
  update(next: { count: number; severity: Severity; attended: boolean }) {
    this.#next = next;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#apply(next);
    }, DEBOUNCE_MS);
  }

  #apply({ count, severity, attended }: { count: number; severity: Severity; attended: boolean }) {
    this.#lazyInit();
    this.#announce(count);

    // Completion flourish: herd drained (>0 → 0) while backgrounded.
    const drained = this.#lastCount > 0 && count === 0 && !attended;
    this.#lastCount = count;

    if (attended) {
      // Attended tier: the live UI is the signal — suppress the tab channel.
      this.#setTitle(this.#baseTitle);
      this.#clearBadge();
      this.#cancelFlourish();
      this.#restoreFavicon();
      return;
    }

    // Background tier.
    this.#setTitle(count > 0 ? `(${count}) ${this.#baseTitle}` : this.#baseTitle);
    if (count > 0) this.#setBadge(count);
    else this.#clearBadge();

    if (drained) {
      this.#flourish();
      return;
    }
    if (this.#flourishTimer) return; // an in-progress flourish owns the favicon
    if (severity === "none") this.#restoreFavicon();
    else this.#setFavicon(this.#renderDot(severity));
  }

  #announce(count: number) {
    const msg = count > 0 ? m.tab_attention_count({ count }) : m.tab_attention_none();
    if (msg !== this.#announcement) this.#announcement = msg;
  }

  #setTitle(title: string) {
    if (document.title !== title) document.title = title;
  }

  #setBadge(n: number) {
    // Progressive enhancement — no-op where unsupported / not installed.
    if ("setAppBadge" in navigator) void navigator.setAppBadge(n).catch(() => {});
  }

  #clearBadge() {
    if ("clearAppBadge" in navigator) void navigator.clearAppBadge().catch(() => {});
  }

  #setFavicon(dataUrl: string) {
    if (!this.#link) return;
    this.#link.type = "image/png";
    this.#link.href = dataUrl;
  }

  #restoreFavicon() {
    if (!this.#link || !this.#originalHref) return;
    // Restore both href AND type (review point 5) — the swap set type=image/png.
    this.#link.type = this.#originalType;
    this.#link.href = this.#originalHref;
  }

  #cancelFlourish() {
    if (this.#flourishTimer) {
      clearTimeout(this.#flourishTimer);
      this.#flourishTimer = null;
    }
  }

  #flourish() {
    this.#setFavicon(this.#renderCheck());
    this.#cancelFlourish();
    this.#flourishTimer = setTimeout(() => {
      this.#flourishTimer = null;
      // Restore to whatever the latest state warrants (may have changed since drain).
      const n = this.#next;
      if (!n || n.attended || n.severity === "none") this.#restoreFavicon();
      else this.#setFavicon(this.#renderDot(n.severity));
    }, FLOURISH_MS);
  }

  #canvas(): [HTMLCanvasElement, CanvasRenderingContext2D, number] {
    const size = Math.round(32 * (window.devicePixelRatio || 1));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    if (this.#baseImg && this.#baseImg.complete && this.#baseImg.naturalWidth > 0) {
      ctx.drawImage(this.#baseImg, 0, 0, size, size);
    }
    return [canvas, ctx, size];
  }

  /** Draw a ground-ringed filled disc in the bottom-right corner; returns its center. */
  #corner(ctx: CanvasRenderingContext2D, size: number, r: number, fill: string): [number, number] {
    const cx = size - r - size * 0.05;
    const cy = size - r - size * 0.05;
    ctx.beginPath();
    ctx.arc(cx, cy, r + size * 0.06, 0, Math.PI * 2);
    ctx.fillStyle = groundColor();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    return [cx, cy];
  }

  /** Base mark + a severity dot in the bottom-right corner, ringed for contrast. */
  #renderDot(sev: Severity): string {
    const [canvas, ctx, size] = this.#canvas();
    if (sev !== "none") this.#corner(ctx, size, size * 0.28, resolveColor(sev));
    return canvas.toDataURL("image/png");
  }

  /** Base mark + a green ✓ disc — the brief completion flourish. */
  #renderCheck(): string {
    const [canvas, ctx, size] = this.#canvas();
    const r = size * 0.3;
    const [cx, cy] = this.#corner(ctx, size, r, resolveColor("green"));
    // check stroke
    ctx.strokeStyle = "#0a0d0c";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy + r * 0.02);
    ctx.lineTo(cx - r * 0.08, cy + r * 0.4);
    ctx.lineTo(cx + r * 0.5, cy - r * 0.35);
    ctx.stroke();
    return canvas.toDataURL("image/png");
  }

  /** Cancel timers and restore the tab to its default title / favicon / badge. */
  dispose() {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#cancelFlourish();
    if (this.#initialized) {
      this.#setTitle(this.#baseTitle);
      this.#restoreFavicon();
      this.#clearBadge();
    }
  }
}

export function createTabSignal(): TabSignal {
  return new TabSignal();
}
