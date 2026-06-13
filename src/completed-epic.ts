import type { EpicChild } from "./epic-core";

export interface CompletedEpicChild {
  number: number;
  title: string;
  url: string;
  prNumber: number | null;
  prUrl: string | null;
  mergedAt: number | null;
  integrated: boolean;
}

export interface CompletedEpic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  completedAt: number;
  children: CompletedEpicChild[];
}

export function buildRollup(
  children: Pick<EpicChild, "number" | "title" | "url">[],
  details: {
    childNumber: number;
    prNumber: number | null;
    prUrl: string | null;
    mergedAt: number;
  }[],
): CompletedEpicChild[] {
  const detailMap = new Map(details.map((d) => [d.childNumber, d]));
  return children.map((child) => {
    const detail = detailMap.get(child.number);
    if (detail) {
      return {
        number: child.number,
        title: child.title,
        url: child.url,
        prNumber: detail.prNumber,
        prUrl: detail.prUrl,
        mergedAt: detail.mergedAt,
        integrated: true,
      };
    }
    return {
      number: child.number,
      title: child.title,
      url: child.url,
      prNumber: null,
      prUrl: null,
      mergedAt: null,
      integrated: false,
    };
  });
}
