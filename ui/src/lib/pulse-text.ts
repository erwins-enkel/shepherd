import { m } from "$lib/paraglide/messages";
import type { TooltipExplanation, TooltipRow, TooltipSection } from "$lib/tooltips/content";
import {
  OVERDUE_FACTOR,
  ciRows,
  steerTally,
  timeline,
  type Pulse,
  type PulseState,
  type TimelineKind,
} from "./session-pulse";
import type { GitState, Session, SteerLogEntry } from "./types";

/** The short, localized name of a progress verdict (card label, panel kicker). */
export function pulseLabel(state: PulseState): string {
  switch (state) {
    case "needs_you":
      return m.pulse_state_needs_you();
    case "looping":
      return m.pulse_state_looping();
    case "ci_failed":
      return m.pulse_state_ci_failed();
    case "ci_overdue":
      return m.pulse_state_ci_overdue();
    case "waiting_ci":
      return m.pulse_state_waiting_ci();
    case "working":
      return m.pulse_state_working();
  }
}

const ROW_CAP = 6;
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** A finished job's duration: "45s" under a minute, else "m:ss" (untranslated, like elapsed()). */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function pulseTitle(state: PulseState): string {
  switch (state) {
    case "needs_you":
      return m.pulse_title_needs_you();
    case "looping":
      return m.pulse_title_looping();
    case "ci_failed":
      return m.pulse_title_ci_failed();
    case "ci_overdue":
      return m.pulse_title_ci_overdue();
    case "waiting_ci":
      return m.pulse_title_waiting_ci();
    case "working":
      return m.pulse_title_working();
  }
}

function pulseSummary(p: Pulse): string {
  const job = p.job;
  const counts = { green: p.green, total: p.total };
  switch (p.state) {
    case "needs_you":
      return m.pulse_summary_needs_you();
    case "looping":
      return m.pulse_summary_looping({ count: p.ciFixRun });
    case "ci_failed":
      return job
        ? m.pulse_summary_failed({ job: job.short, ...counts })
        : m.pulse_summary_failed_plain();
    case "ci_overdue":
      return m.pulse_summary_overdue({
        job: job!.short,
        elapsed: minutes(job!.elapsedMs ?? 0),
        typical: minutes(job!.typicalMs ?? 0),
      });
    case "waiting_ci":
      if (!job || job.elapsedMs == null) return m.pulse_summary_waiting_plain();
      return job.typicalMs && p.etaMs
        ? m.pulse_summary_waiting_eta({
            ...counts,
            job: job.short,
            elapsed: minutes(job.elapsedMs),
            typical: minutes(job.typicalMs),
            eta: clock(p.etaMs),
          })
        : m.pulse_summary_waiting({ ...counts, job: job.short, elapsed: minutes(job.elapsedMs) });
    case "working":
      return p.step ? m.pulse_summary_working_step({ ...p.step }) : m.pulse_summary_working();
  }
}

const CI_TONE = { success: "ok", pending: "run", failure: "fail", none: "idle" } as const;

function ciSection(p: Pulse, git: GitState | undefined, nowMs: number): TooltipSection | null {
  const rows = ciRows(git?.state === "open" ? git.jobs : undefined, nowMs);
  if (rows.length === 0) return null;
  const urgent = rows.filter((r) => r.state !== "success");
  const green = rows.filter((r) => r.state === "success");
  const room = Math.max(0, ROW_CAP - urgent.length);
  const shown = [...urgent, ...green.slice(0, room)];
  const out: TooltipRow[] = shown.map((r) => ({
    text: r.name,
    tone: CI_TONE[r.state],
    aside:
      r.elapsedMs != null
        ? r.typicalMs
          ? m.pulse_minutes_of({ elapsed: minutes(r.elapsedMs), typical: minutes(r.typicalMs) })
          : m.pulse_minutes({ elapsed: minutes(r.elapsedMs) })
        : r.durationMs != null
          ? duration(r.durationMs)
          : undefined,
  }));
  if (green.length > room)
    out.push({ text: m.pulse_ci_more_green({ count: green.length - room }), tone: "ok" });
  return { label: m.pulse_section_ci({ green: p.green, total: p.total }), text: "", rows: out };
}

const EVENT: Record<TimelineKind, { label: () => string; tone: TooltipRow["tone"] }> = {
  start: { label: m.pulse_event_start, tone: "idle" },
  pr: { label: m.pulse_event_pr, tone: "ok" },
  go: { label: m.pulse_event_go, tone: "ok" },
  plan_review: { label: m.pulse_event_plan_review, tone: "idle" },
  ci_fix: { label: m.pulse_event_ci_fix, tone: "fail" },
  rebase: { label: m.pulse_event_rebase, tone: "warn" },
  open_pr: { label: m.pulse_event_open_pr, tone: "idle" },
  nudge: { label: m.pulse_event_nudge, tone: "idle" },
  review: { label: m.pulse_event_review, tone: "warn" },
  queue: { label: m.pulse_event_queue, tone: "idle" },
  operator: { label: m.pulse_event_operator, tone: "idle" },
};

function historySection(
  session: Session,
  git: GitState | undefined,
  steers: readonly SteerLogEntry[] | undefined,
): TooltipSection {
  const events = timeline(session, git, steers);
  const shown = events.slice(-ROW_CAP);
  const rows: TooltipRow[] = shown.map((e) => {
    const kind = EVENT[e.kind] ?? EVENT.operator; // a newer server's unknown kind reads as yours
    return { text: kind.label(), aside: clock(e.ts), tone: kind.tone };
  });
  if (events.length > shown.length)
    rows.unshift({ text: m.pulse_event_earlier({ count: events.length - shown.length }) });
  return { label: m.pulse_section_history(), text: "", rows };
}

function loopSection(p: Pulse, steers: readonly SteerLogEntry[] | undefined): TooltipSection {
  if (!steers) return { label: m.pulse_section_loop(), text: m.common_loading() };
  const t = steerTally(steers);
  const looping = p.state === "looping";
  return {
    label: m.pulse_section_loop(),
    text: m.pulse_loop_text({
      shepherd: t.shepherd,
      operator: t.operator,
      ciFix: t.ciFix,
      run: t.ciFixRun,
    }),
    rows: [
      looping
        ? { text: m.pulse_loop_yes({ run: t.ciFixRun }), tone: "fail" }
        : { text: m.pulse_loop_none(), tone: "ok" },
    ],
  };
}

function nextSection(p: Pulse): TooltipSection {
  const rows: TooltipRow[] = (() => {
    switch (p.state) {
      case "waiting_ci":
        return [
          { text: m.pulse_next_green(), tone: "ok" as const },
          { text: m.pulse_next_red(), tone: "fail" as const },
          ...(p.job?.typicalMs
            ? [
                {
                  text: m.pulse_next_overdue({ limit: minutes(p.job.typicalMs * OVERDUE_FACTOR) }),
                  tone: "warn" as const,
                },
              ]
            : []),
        ];
      case "ci_overdue":
        return [{ text: m.pulse_next_check_runner(), tone: "warn" as const }];
      case "ci_failed":
        return [{ text: m.pulse_next_failed(), tone: "fail" as const }];
      case "looping":
        return [{ text: m.pulse_next_looping(), tone: "fail" as const }];
      case "needs_you":
        return [{ text: m.pulse_next_needs_you(), tone: "warn" as const }];
      case "working":
        return [{ text: m.pulse_next_working(), tone: "idle" as const }];
    }
  })();
  return { label: m.pulse_section_next(), text: "", rows };
}

/** The session status panel's content: the verdict as title, what it rests on as summary, and
 *  one idea per section — CI, history, loop check, what happens next. */
export function pulseExplanation(input: {
  pulse: Pulse;
  session: Session;
  git?: GitState;
  steers?: readonly SteerLogEntry[];
  nowMs: number;
}): TooltipExplanation {
  const { pulse, session, git, steers, nowMs } = input;
  const ci = ciSection(pulse, git, nowMs);
  return {
    title: pulseTitle(pulse.state),
    summary: pulseSummary(pulse),
    sections: [
      ...(ci ? [ci] : []),
      historySection(session, git, steers),
      loopSection(pulse, steers),
      nextSection(pulse),
    ],
  };
}
