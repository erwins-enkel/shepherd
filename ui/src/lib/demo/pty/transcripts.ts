// Authored PTY transcripts — the "watch the agent work" showpiece. Each is an
// array of timed byte-string frames (see `replay.ts`) that, replayed, look like a
// live Claude-Code-style agent session in xterm. Content is fictional, tasteful,
// and PUBLIC (marketing) — no secrets, real names, or profanity.
//
// This file is DATA ONLY: the frames and the tiny helpers that build them. All
// timing/scheduling logic lives in `replay.ts`. Transcripts are keyed by the
// stable session ids from `seed.ts` — an unknown id falls back to a minimal
// generic frame (never throws).

import type { PtyFrame } from "./replay";

// ── ANSI palette (xterm consumes these raw) ──────────────────────────────────
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const NL = "\r\n";

const c = {
  dim: (s: string) => DIM + s + RESET,
  bold: (s: string) => BOLD + s + RESET,
  green: (s: string) => GREEN + s + RESET,
  red: (s: string) => RED + s + RESET,
  cyan: (s: string) => CYAN + s + RESET,
  gray: (s: string) => GRAY + s + RESET,
};

// Frame builder: `f(delayMs, line)` emits `line` + CRLF after `delayMs`.
const f = (delayMs: number, line = ""): PtyFrame => ({ delayMs, bytes: line + NL });

// Common line shapes so the transcripts read consistently.
const bullet = (delayMs: number, text: string): PtyFrame => f(delayMs, "● " + text);
const result = (delayMs: number, text: string): PtyFrame =>
  f(delayMs, c.gray("  ⎿ ") + c.dim(text));
const tool = (delayMs: number, call: string): PtyFrame => f(delayMs, "● " + c.cyan(call));
const check = (delayMs: number, text: string): PtyFrame =>
  f(delayMs, "    " + c.green("✓ ") + text);
const add = (delayMs: number, text: string): PtyFrame => f(delayMs, "    " + c.green("+ " + text));
const del = (delayMs: number, text: string): PtyFrame => f(delayMs, "    " + c.red("- " + text));
const ctx = (delayMs: number, text: string): PtyFrame => f(delayMs, "    " + c.gray("  " + text));

/** Header block every transcript opens with: task line + dim metadata line. */
function header(title: string, meta: string): PtyFrame[] {
  return [f(0, c.bold("● " + title)), f(30, c.dim("  " + meta)), f(120)];
}

// ── HERO: coupon — a rich, believable working session ────────────────────────
function coupon(): PtyFrame[] {
  return [
    ...header(
      "Add coupon-code field to checkout",
      "TASK-41 · acme/storefront · shepherd/coupon-code-field · opus",
    ),
    bullet(140, "I'll add a coupon-code field to the checkout summary and apply the discount"),
    f(40, "  to the order total. Let me find the checkout components first."),
    f(260),

    tool(180, 'Search(grep "checkout" src/routes)'),
    result(220, "Found 4 files"),
    ctx(60, "src/routes/checkout/+page.svelte"),
    ctx(50, "src/routes/checkout/Summary.svelte"),
    ctx(50, "src/lib/pricing/apply.ts"),
    ctx(50, "src/lib/pricing/types.ts"),
    f(240),

    tool(200, "Read(src/routes/checkout/Summary.svelte)"),
    result(300, "Read 86 lines"),
    f(220),
    bullet(160, "The summary lists line items and totals but has no promo input."),
    f(40, "  I'll add a CouponField component, validate codes against the pricing"),
    f(40, "  API, and fold the discount into the total."),
    f(280),

    tool(200, "Read(src/lib/pricing/apply.ts)"),
    result(260, "Read 42 lines"),
    f(60, c.dim("    applyPricing(cart) → { subtotal, shipping, total }")),
    f(240),

    bullet(180, "Adding the component."),
    tool(120, "Create(src/routes/checkout/CouponField.svelte)"),
    result(200, "Created file  (+38)"),
    add(60, '<script lang="ts">'),
    add(40, "  let { onApply } = $props();"),
    add(40, "  let code = $state('');"),
    add(40, "  let error = $state('');"),
    ctx(30, "…"),
    add(40, '<label class="coupon">'),
    add(40, "  <span>Coupon code</span>"),
    add(40, '  <input bind:value={code} placeholder="Enter code" />'),
    add(40, "</label>"),
    f(240),

    tool(200, "Update(src/routes/checkout/Summary.svelte)"),
    result(200, "Updated  (+7 -1)"),
    ctx(40, "import CouponField from './CouponField.svelte';"),
    add(50, "<CouponField onApply={applyCoupon} />"),
    del(40, "const total = subtotal + shipping;"),
    add(50, "const total = subtotal + shipping - discount;"),
    f(240),

    tool(200, "Update(src/lib/pricing/apply.ts)"),
    result(200, "Updated  (+14)"),
    add(50, "export function applyCoupon(code: string, subtotal: number) {"),
    add(40, "  const promo = lookupPromo(code);"),
    add(40, "  if (!promo) return { ok: false, reason: 'unknown' };"),
    add(40, "  const discount = Math.round(subtotal * promo.rate);"),
    add(40, "  return { ok: true, discount };"),
    add(40, "}"),
    f(300),

    bullet(200, "Running the pricing tests."),
    tool(120, "Bash(bun test src/lib/pricing)"),
    f(500, c.dim("    bun test v1.2  (src/lib/pricing)")),
    check(360, "applies a valid coupon to the subtotal"),
    check(300, "rejects an unknown code"),
    check(280, "ignores an expired coupon"),
    check(300, "rounds the discount to whole cents"),
    f(160, c.green("    4 pass") + c.dim(", 0 fail") + c.gray("  (238ms)")),
    f(320),

    bullet(
      220,
      c.green("✓ ") + "Coupon field added — the discount now applies to the summary total.",
    ),
    f(60, "  Next: a component test for the invalid-code path, then open a PR."),
    f(200),
    f(120, c.dim("  Waiting…")),
  ];
}

// ── checkout-child — shorter working transcript (shipping estimator) ──────────
function checkoutChild(): PtyFrame[] {
  return [
    ...header(
      "Add a shipping-cost estimator to checkout",
      "TASK-42 · acme/storefront · shepherd/shipping-estimator · autopilot",
    ),
    bullet(140, "Estimating shipping from cart weight + destination, shown in the summary."),
    f(220),
    tool(180, 'Search(grep "weight" src/lib/cart)'),
    result(220, "Found 2 files"),
    ctx(50, "src/lib/cart/item.ts"),
    ctx(50, "src/lib/cart/totals.ts"),
    f(220),
    tool(180, "Create(src/lib/shipping/estimate.ts)"),
    result(200, "Created file  (+26)"),
    add(50, "export function estimateShipping(weightG: number, zone: Zone) {"),
    add(40, "  const base = ZONE_BASE[zone];"),
    add(40, "  return base + Math.ceil(weightG / 500) * ZONE_PER_500G[zone];"),
    add(40, "}"),
    f(240),
    tool(180, "Update(src/routes/checkout/Summary.svelte)"),
    result(200, "Updated  (+6)"),
    add(50, "<li>Estimated shipping <b>{fmt(shipping)}</b></li>"),
    f(240),
    bullet(180, "Running the type check."),
    tool(120, "Bash(bun run check)"),
    f(500, c.dim("    svelte-check…")),
    f(360, c.green("    ✓ 0 errors") + c.dim(", 0 warnings")),
    f(280),
    bullet(180, "Estimator wired into the summary. Continuing with a unit test."),
    f(160, c.dim("  Waiting…")),
  ];
}

// ── Static scrollbacks (paint fast; reflect each session's end-state) ─────────
const NEON_QUESTION =
  "The Neon branch starts empty — should I seed it from the current Postgres dump,";
const NEON_QUESTION_2 = "or start clean and let migrations rebuild it?";

function rounding(): PtyFrame[] {
  return [
    ...header(
      "Fix cart-total rounding on 3-for-2 offers",
      "TASK-38 · acme/storefront · shepherd/fix-cart-rounding · sonnet",
    ),
    bullet(30, "Switched the running total to integer cents and rounded once at the end."),
    tool(20, "Bash(bun test src/lib/cart)"),
    check(20, "rounds a 3-for-2 order without dropping a cent"),
    check(15, "totals match to the cent"),
    f(15, c.green("    2 pass") + c.dim(", 0 fail")),
    bullet(20, c.green("✓ ") + "Opened PR #512 · CI green · ready to merge."),
  ];
}

function authstore(): PtyFrame[] {
  return [
    ...header(
      "Rework the auth session store to rotating refresh tokens",
      "TASK-44 · acme/api · shepherd/auth-session-store · opus",
    ),
    bullet(30, "Drafted a plan: short-lived access token + rotating refresh token."),
    ctx(20, "1. Add a refresh_tokens table (hashed, family id)"),
    ctx(15, "2. Issue short-lived access + rotating refresh on login"),
    ctx(15, "3. Rotate on refresh; revoke the family on reuse"),
    ctx(15, "4. Migrate existing sessions on next login"),
    bullet(25, c.green("✓ ") + "Plan approved. Waiting for your Go to start implementing."),
  ];
}

function neon(): PtyFrame[] {
  return [
    ...header(
      "Migrate the API database layer to Neon serverless Postgres",
      "TASK-45 · acme/api · shepherd/neon-postgres · autopilot",
    ),
    bullet(30, "Provisioned a Neon branch and updated the connection layer."),
    bullet(20, "One decision is needed before I continue:"),
    f(20, "  " + NEON_QUESTION),
    f(15, "  " + NEON_QUESTION_2),
    f(20, c.dim("  Autopilot paused — waiting for your answer.")),
  ];
}

function ogimg(): PtyFrame[] {
  return [
    ...header(
      "Generate dynamic OG images for product pages",
      "TASK-39 · acme/storefront · shepherd/og-images · sonnet",
    ),
    bullet(30, "Added an OG image endpoint and a per-product render cache."),
    tool(20, "Bash(bun run check)"),
    f(20, c.green("    ✓ 0 errors")),
    bullet(20, "Opened PR #508 · CI green."),
    bullet(20, c.green("✓ ") + "Added to the merge train — landing now."),
  ];
}

function deps(): PtyFrame[] {
  return [
    ...header(
      "Bump dependencies to latest and fix lint",
      "TASK-37 · acme/storefront · shepherd/bump-deps · sonnet",
    ),
    bullet(30, "Upgraded 34 packages, regenerated the lockfile, fixed the new lint errors."),
    tool(20, "Bash(bun run lint)"),
    f(20, c.green("    ✓ 0 problems")),
    bullet(20, c.green("✓ ") + "Merged PR #505."),
    f(20, c.dim("  Owed: rotate the CI dependency-cache key (post-merge).")),
  ];
}

function generic(id: string): PtyFrame[] {
  return [f(0, c.dim(`attached to demo session ${id}`))];
}

const TRANSCRIPTS: Record<string, () => PtyFrame[]> = {
  coupon,
  "checkout-child": checkoutChild,
  rounding,
  authstore,
  neon,
  ogimg,
  deps,
};

/** The authored transcript for `id`, or a minimal generic frame for unknown ids. */
export function transcriptFor(id: string): PtyFrame[] {
  return (TRANSCRIPTS[id] ?? (() => generic(id)))();
}
