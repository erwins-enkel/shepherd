import { m } from "$lib/paraglide/messages";
import type { RecapEvidenceKind, RecapSkip, RecapSkipParams } from "./types";

/** Localized landed-work evidence clause for a recap-skip body. Built from the typed kind (+ optional
 *  PR number) — never a server-authored English string — so a DE body embeds no English. A
 *  `merged_pr` without a PR number renders "merged PR" (never "merged PR #undefined"). */
function evidencePhrase(kind: RecapEvidenceKind | undefined, pr: number | undefined): string {
  switch (kind) {
    case "merged_pr":
      return pr != null
        ? m.recap_skip_evidence_merged_pr({ pr })
        : m.recap_skip_evidence_merged_pr_no_number();
    case "review":
      return m.recap_skip_evidence_review();
    case "existing_recap":
      return m.recap_skip_evidence_existing_recap();
    default:
      return "";
  }
}

/** Localized headline for a coded recap skip. */
export function recapSkipHeadline(skip: RecapSkip): string {
  switch (skip.code) {
    case "metadata-mismatch":
      return m.recap_skip_metadata_mismatch_headline();
    case "base-refresh-failed":
      return m.recap_skip_base_refresh_failed_headline();
    case "ancestry-check-failed":
      return m.recap_skip_ancestry_check_failed_headline();
    case "empty-diff-contradicted":
      return m.recap_skip_empty_diff_contradicted_headline();
  }
}

/** Localized body for a coded recap skip. Identifiers (branch/baseRef) pass through verbatim; the
 *  evidence clause is resolved from its typed kind and interpolated as `{evidence}`. */
export function recapSkipBody(skip: RecapSkip): string {
  const p: RecapSkipParams = skip.params;
  const evidence = evidencePhrase(p.evidenceKind, p.evidencePr);
  switch (skip.code) {
    case "metadata-mismatch":
      return m.recap_skip_metadata_mismatch_body({
        branch: p.branch ?? "",
        current: p.current ?? "",
      });
    case "base-refresh-failed":
      return m.recap_skip_base_refresh_failed_body({ evidence });
    case "ancestry-check-failed":
      return m.recap_skip_ancestry_check_failed_body({ evidence, baseRef: p.baseRef ?? "" });
    case "empty-diff-contradicted":
      return m.recap_skip_empty_diff_contradicted_body({ evidence, baseRef: p.baseRef ?? "" });
  }
}
