import type { EpicChild, EpicChildState } from "$lib/types";
import { m } from "$lib/paraglide/messages";

export type ChipTone = "done" | "review" | "running" | "ready" | "muted";

const TONES: Record<EpicChildState, ChipTone> = {
  merged: "done",
  "in-review": "review",
  running: "running",
  ready: "ready",
  blocked: "muted",
};

export function chipFor(state: EpicChildState): { key: EpicChildState; tone: ChipTone } {
  return { key: state, tone: TONES[state] };
}

export function stateLabel(s: EpicChildState): string {
  const labels: Record<EpicChildState, string> = {
    merged: m.epic_state_merged(),
    "in-review": m.epic_state_in_review(),
    running: m.epic_state_running(),
    ready: m.epic_state_ready(),
    blocked: m.epic_state_blocked(),
  };
  return labels[s];
}

export function progress(children: Pick<EpicChild, "state">[]): {
  merged: number;
  total: number;
} {
  return {
    merged: children.filter((c) => c.state === "merged").length,
    total: children.length,
  };
}
