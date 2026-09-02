/**
 * The canonical INTENT SHAPE — Problem / Outcome / Constraints / Non-goals / Open questions
 * (issue #2158, playbook R6).
 *
 * One section list, two consumers that must not drift:
 *
 *  1. {@link composeTaskBrief} — renders the New Task "shape this" round (src/task-shape.ts +
 *     the `/api/shape/brief` route) into the prompt the operator starts a session with.
 *  2. {@link INTENT_ISSUE_TEMPLATE} — the issue template the readiness analyzer (src/readiness.ts)
 *     prescribes for a managed repo, so a DRAINED backlog issue arrives in the same shape a shaped
 *     task does.
 *
 * The brief lives on the server rather than in `ui/` precisely so those two stay one definition:
 * `ui/` cannot import root `src/` (it mirrors types by hand), so a client-side composer would be a
 * second copy of this shape, free to drift from the template.
 *
 * Both outputs are agent/repo-facing artifacts in fixed English — the brief becomes a spawn prompt,
 * the template is written into a TARGET repo — so, like the spawn directives in src/service.ts and
 * the generated house rules in src/readiness.ts, they are exempt from i18n.
 */
import type { ResolvedAnswer } from "./plan-gate";
import type { PlanQuestion } from "./visual-blocks";

/** One section of the intent shape: the heading both artifacts render, and the prompt-side hint
 *  that tells a human (issue template) or an agent (shaping prompt) what belongs under it. */
export interface IntentSection {
  heading: string;
  hint: string;
}

/** The intent shape, in order. Edit HERE — every artifact below is derived from it. */
export const INTENT_SECTIONS: readonly IntentSection[] = [
  {
    heading: "Problem",
    hint: "What is wrong or missing today, and who it hurts. Not a proposed solution.",
  },
  {
    heading: "Outcome",
    hint: "What is observably true once this lands — the result, not the implementation.",
  },
  {
    heading: "Constraints",
    hint: "What the change must respect: existing behaviour, compatibility, budgets, prior decisions.",
  },
  {
    heading: "Non-goals",
    hint: "What this deliberately does NOT do, so scope cannot drift mid-session.",
  },
  {
    heading: "Open questions",
    hint: "What is still undecided and needs an answer before or during the work.",
  },
] as const;

/** The four sections the shaping helper drafts; "Open questions" is filled from the round itself. */
export interface TaskBriefDraft {
  problem: string;
  outcome: string;
  constraints: string[];
  nonGoals: string[];
}

/** Render a `- ` bullet list from non-blank trimmed lines, or "" when none. */
function bullets(items: readonly string[]): string {
  const rows = items.map((s) => s.trim()).filter(Boolean);
  return rows.length ? rows.map((r) => `- ${r}`).join("\n") : "";
}

/** `## Heading` + body, or "" when the body is empty (an empty section is noise in a prompt). */
function section(heading: string, body: string): string {
  return body.trim() ? `## ${heading}\n${body.trim()}` : "";
}

/** One answer rendered flat, mirroring `planAnswerSteerText`'s vocabulary so the two agent-facing
 *  renderings of an answered question read the same. */
function answerText(a: ResolvedAnswer): string {
  if (a.kind === "freeform") return a.text ?? "";
  if (a.kind === "multi") return a.selected.length ? a.selected.join(", ") : "(none selected)";
  return a.selected[0] ?? "";
}

/**
 * Compose the intent-shaped task brief that replaces the operator's rough prompt.
 *
 * `answers` are the resolved (fail-closed) answers from `resolvePlanAnswers`; any question with no
 * resolved answer is carried into "Open questions" rather than dropped — an unanswered question is
 * exactly the ambiguity this round exists to surface, so it must reach the session, not vanish.
 */
export function composeTaskBrief(
  draft: TaskBriefDraft,
  questions: readonly PlanQuestion[],
  answers: readonly ResolvedAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const clarifications = questions
    .map((q) => {
      const a = byId.get(q.id);
      return a ? `- ${q.prompt.trim()}\n  → ${answerText(a)}` : null;
    })
    .filter((l): l is string => l !== null)
    .join("\n");
  const unanswered = questions.filter((q) => !byId.has(q.id)).map((q) => q.prompt);

  return (
    [
      section("Problem", draft.problem),
      section("Outcome", draft.outcome),
      section("Constraints", bullets(draft.constraints)),
      section("Non-goals", bullets(draft.nonGoals)),
      section("Clarifications", clarifications),
      section("Open questions", bullets(unanswered)),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

/**
 * The issue template the readiness analyzer prescribes: the same sections, as an HTML-commented
 * skeleton a human fills in. Front matter is GitHub's `.github/ISSUE_TEMPLATE/*.md` chooser format;
 * a GitLab repo drops it and keeps the body (see the analyzer's install steps).
 */
export const INTENT_ISSUE_TEMPLATE = `---
name: Task
about: A task shaped so an agent can start on it without a clarifying round
title: ""
labels: []
---

${INTENT_SECTIONS.map((s) => `## ${s.heading}\n\n<!-- ${s.hint} -->`).join("\n\n")}
`;
