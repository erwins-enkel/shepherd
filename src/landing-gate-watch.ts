import type { CompletedEpic } from "./completed-epic";

/**
 * The landing gate of an open completed epic, pushed when it moves (#2858). The drain observes
 * each open landing row every tick from reads it already made; this decides which of those rows
 * changed since the last push. Clients compare the `…At` timestamps with their own clock, so the
 * time-derived booleans (`landingStranded`, `landingConflictStranded`) never count as a change.
 */
export function landingGateSignature(row: CompletedEpic): string {
  const { landingStranded, landingConflictStranded, ...rest } = row;
  void landingStranded;
  void landingConflictStranded;
  return JSON.stringify(rest);
}

interface Pushed {
  sig: string;
  row: CompletedEpic;
}

export class LandingGateWatch {
  /** repoPath → parentIssueNumber → the row last pushed (and its signature). */
  private readonly last = new Map<string, Map<number, Pushed>>();

  constructor(private readonly emit: (row: CompletedEpic) => void) {}

  /**
   * One repo's observation. `openParents` are every open landing row of the repo — observed or
   * not — so a row left unobserved this tick keeps its signature; the others are forgotten (a
   * re-opened landing pushes afresh). `observed` are the enriched rows to compare and push.
   */
  observe(repoPath: string, openParents: ReadonlySet<number>, observed: CompletedEpic[]): void {
    const seen = this.last.get(repoPath) ?? new Map<number, Pushed>();
    for (const parent of seen.keys()) if (!openParents.has(parent)) seen.delete(parent);
    for (const row of observed) {
      const sig = landingGateSignature(row);
      if (seen.get(row.parentIssueNumber)?.sig === sig) continue;
      seen.set(row.parentIssueNumber, { sig, row });
      this.emit(row);
    }
    if (seen.size > 0) this.last.set(repoPath, seen);
    else this.last.delete(repoPath);
  }

  /** The row last pushed for this landing — what every connected client holds — or undefined. */
  pushed(repoPath: string, parentIssueNumber: number): CompletedEpic | undefined {
    return this.last.get(repoPath)?.get(parentIssueNumber)?.row;
  }
}
