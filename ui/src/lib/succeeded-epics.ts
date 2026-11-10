import type { CompletedEpic } from "#lib/types.js";
import { getLocale } from "#lib/i18n.js";
import { firstSafeHttpUrl } from "#lib/url.js";

/** #3838: a succeeded epic — its landing PR merged, or every child of an incremental epic merged
 *  on its own. It leaves the "Epics to land" band for its own and stays until acknowledged. */
export function isSucceededEpic(e: Pick<CompletedEpic, "outcome">): boolean {
  return e.outcome === "landed" || e.outcome === "incremental";
}

/** When the epic succeeded; a row from before #3838 falls back to its completion. */
export function successTime(e: Pick<CompletedEpic, "succeededAt" | "completedAt">): number {
  return e.succeededAt ?? e.completedAt;
}

/** The succeeded epics among `epics`, newest success first. */
export function succeededEpicsOf(epics: readonly CompletedEpic[]): CompletedEpic[] {
  return epics.filter(isSucceededEpic).sort((a, b) => successTime(b) - successTime(a));
}

/** An absolute, locale-formatted date and time — the completion must stay traceable, not just
 *  "7 h ago". */
export function successStamp(ts: number): string {
  return new Date(ts).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
}

/** The epic issue's forge URL, derived from a child issue's URL (the row carries none of its own). */
export function epicIssueHref(
  e: Pick<CompletedEpic, "children" | "parentIssueNumber">,
): string | null {
  const ref = e.children.find((c) => c.url)?.url;
  return firstSafeHttpUrl(ref ? ref.replace(/\/\d+(?=\/?$)/, `/${e.parentIssueNumber}`) : null);
}
