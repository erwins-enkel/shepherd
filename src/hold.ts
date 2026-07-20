import type { BlockReason } from "./blocked";
import type { HoldCode, HoldParams, HoldReason } from "./types";

// ── blockReasonToHoldCode ─────────────────────────────────────────────────────

/** Map a BlockReason to a HoldCode, matching blockSummary()'s switch in push.ts exactly. */
export function blockReasonToHoldCode(block: BlockReason): HoldCode {
  switch (block.shape) {
    case "menu":
      return "blocked-menu";
    case "yes-no":
      return "blocked-yes-no";
    case "awaiting-input":
      return "blocked-awaiting-input";
    case "stall":
      return "blocked-stall";
    case "quota":
      switch (block.quotaKind) {
        case "rework":
          return "quota-rework";
        case "review":
          return "quota-review";
        case "error":
          return "quota-error";
        case "plan":
          return "quota-plan";
        default:
          return "blocked-generic";
      }
    default:
      return "blocked-generic";
  }
}

// ── renderHold ────────────────────────────────────────────────────────────────

/** Locale-formatted clock time of a window reset, matching push.ts resetTimeLabel. */
function resetTimeLabel(resetAt: number | undefined, locale: "en" | "de"): string | null {
  if (resetAt === undefined) return null;
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt));
}

type CopyMap = Record<HoldCode, (params: HoldParams, locale: "en" | "de") => string>;

const EN: CopyMap = {
  "halted-error": () => "Halted on an error — needs you.",
  "halted-usage": (p, locale) => {
    const time = resetTimeLabel(p.resetAt, locale);
    return time ? `Paused at the usage limit — resumes at ${time}.` : "Paused at the usage limit.";
  },
  "autopilot-paused": (p) =>
    p.question && p.question.trim() ? p.question : "Autopilot paused for your input.",
  "blocked-menu": () => "Waiting on a menu choice.",
  "blocked-yes-no": () => "Waiting on a yes/no.",
  "blocked-awaiting-input": () => "Waiting on your input.",
  "blocked-stall": () => "Quiet — no recent activity; may be stuck.",
  "blocked-generic": () => "Waiting on your input.",
  "quota-rework": () => "Auto-fix hit its limit — open findings still need you.",
  "quota-review": () => "Critic keeps finding issues — auto-review paused.",
  "quota-error": () => "Critic can't review this PR — needs you.",
  "quota-plan": () => "Plan review stuck — keeps requesting changes.",
  "plan-rework": (p) =>
    `Plan review wants changes (round ${p.round ?? "?"}/${p.cap ?? "?"}) — your call.`,
  "plan-question": () => "The plan has questions waiting on your answer.",
  "critic-rework": (p) =>
    p.findings !== undefined
      ? `Critic requested changes (${p.findings} open) — steered back to the agent.`
      : "Critic requested changes — steered back to the agent.",
  "ci-red": (p) => `CI is failing${p.pr !== undefined ? ` on PR #${p.pr}` : ""} — needs a fix.`,
  "pr-conflict": (p) =>
    `${p.pr !== undefined ? `PR #${p.pr} has` : "The PR has"} merge conflicts — CI can't run until it's rebased.`,
  "awaiting-merge": (p) =>
    `Ready and handed to a merger${p.pr !== undefined ? ` (PR #${p.pr})` : ""}.`,
  "train-error": (p) =>
    `Merge train hit an error${p.pr !== undefined ? ` on PR #${p.pr}` : ""} — needs you.`,
  stalled: () => "Quiet — no recent activity; may be stuck.",
  "recap-attention": () => "Recap flagged this for your attention.",
  merging: (p) => `In the merge train${p.pr !== undefined ? ` (PR #${p.pr})` : ""}.`,
  "merge-rebasing": (p) => `Rebasing in the merge train (attempt ${p.rebaseCount ?? "?"}).`,
  "ready-merge": (p) =>
    `Ready to merge${p.pr !== undefined ? ` (PR #${p.pr})` : ""} — waiting on you.`,
  "manual-steps": (p) =>
    `${p.steps ?? 1} manual step${(p.steps ?? 1) === 1 ? "" : "s"} to do before merge — ack to proceed.`,
};

const DE: CopyMap = {
  "halted-error": () => "Auf einem Fehler gestoppt — braucht dich.",
  "halted-usage": (p, locale) => {
    const time = resetTimeLabel(p.resetAt, locale);
    return time
      ? `Am Nutzungslimit pausiert — wird um ${time} fortgesetzt.`
      : "Am Nutzungslimit pausiert.";
  },
  "autopilot-paused": (p) =>
    p.question && p.question.trim() ? p.question : "Autopilot pausiert für deine Eingabe.",
  "blocked-menu": () => "Wartet auf eine Menüauswahl.",
  "blocked-yes-no": () => "Wartet auf ein Ja/Nein.",
  "blocked-awaiting-input": () => "Wartet auf deine Eingabe.",
  "blocked-stall": () => "Ruhig — keine Aktivität; möglicherweise hängengeblieben.",
  "blocked-generic": () => "Wartet auf deine Eingabe.",
  "quota-rework": () => "Auto-Fix am Limit — offene Punkte brauchen dich.",
  "quota-review": () => "Kritiker findet weiter Probleme — Auto-Review pausiert.",
  "quota-error": () => "Kritiker kann den PR nicht prüfen — braucht dich.",
  "quota-plan": () => "Plan-Review hängt — fordert weiter Änderungen.",
  "plan-rework": (p) =>
    `Plan-Review fordert Änderungen (Runde ${p.round ?? "?"}/${p.cap ?? "?"}) — deine Entscheidung.`,
  "plan-question": () => "Der Plan hat Fragen, die auf deine Antwort warten.",
  "critic-rework": (p) =>
    p.findings !== undefined
      ? `Kritiker fordert Änderungen (${p.findings} offen) — zurück zum Agenten gesteuert.`
      : "Kritiker fordert Änderungen — zurück zum Agenten gesteuert.",
  "ci-red": (p) =>
    `CI schlägt fehl${p.pr !== undefined ? ` bei PR #${p.pr}` : ""} — braucht eine Korrektur.`,
  "pr-conflict": (p) =>
    `${p.pr !== undefined ? `PR #${p.pr} hat` : "Der PR hat"} Merge-Konflikte — CI kann bis zum Rebase nicht laufen.`,
  "awaiting-merge": (p) =>
    `Bereit und an einen Merger übergeben${p.pr !== undefined ? ` (PR #${p.pr})` : ""}.`,
  "train-error": (p) =>
    `Merge-Train hat einen Fehler${p.pr !== undefined ? ` bei PR #${p.pr}` : ""} — braucht dich.`,
  stalled: () => "Ruhig — keine Aktivität; möglicherweise hängengeblieben.",
  "recap-attention": () => "Recap hat dies für deine Aufmerksamkeit markiert.",
  merging: (p) => `Im Merge-Train${p.pr !== undefined ? ` (PR #${p.pr})` : ""}.`,
  "merge-rebasing": (p) => `Rebase im Merge-Train (Versuch ${p.rebaseCount ?? "?"}).`,
  "ready-merge": (p) =>
    `Bereit zum Mergen${p.pr !== undefined ? ` (PR #${p.pr})` : ""} — wartet auf dich.`,
  "manual-steps": (p) =>
    `${p.steps ?? 1} manuelle${(p.steps ?? 1) === 1 ? "r" : ""} Schritt${(p.steps ?? 1) === 1 ? "" : "e"} vor dem Mergen — bestätigen zum Fortfahren.`,
};

/** Server-side localized copy for a hold reason. Locale "de" → German, else English. */
export function renderHold(hold: HoldReason, locale: string): string {
  const map = locale === "de" ? DE : EN;
  const params: HoldParams = hold.params ?? {};
  const fn = map[hold.code];
  return fn(params, locale === "de" ? "de" : "en");
}
