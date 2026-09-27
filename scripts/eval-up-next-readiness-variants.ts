// Candidate readiness questions for the #2535 eval, PRE-REGISTERED before any of them was scored.
//
// v1 was the first production question; v4 won (dev AUROC best, full-set GO) and is now production
// (`src/up-next-readiness-core.ts`). Keys are cache keys in the fixture file — never renumber. Pick
// on the dev split, confirm once on the holdout; a winner moves into the production core. A
// variant's score is the MEAN of its nouls' `p` (null if any answer is unusable).

import type { JudgeNoulQuestion } from "../src/judge";
import { READINESS_QUESTION } from "../src/up-next-readiness-core";

export interface ReadinessVariant {
  describe: string;
  questions: Record<string, JudgeNoulQuestion>;
}

export const VARIANTS: Record<string, ReadinessVariant> = {
  v1: {
    describe: "one noul, criteria list the four no-reasons (first production question)",
    questions: {
      ready: {
        type: "noul",
        instructions: READINESS_QUESTION.instructions,
        criteria: {
          true:
            "The scope is clear and bounded, the outcome is concrete enough that the agent can tell " +
            "when it is done, and the work fits in one reviewable pull request without further input.",
          false:
            "The scope is vague or open-ended; it needs a design or product decision from a person " +
            "first; it is too large for one pull request (an epic or multi-step migration); or it is " +
            "blocked on something external — another issue, a third party, credentials, or a human " +
            "action. Judge whether the WORK is startable, not whether the text is well written.",
        },
      },
    },
  },
  // v1 reads long, well-specified issues as not-ready when they merely MENTION a decision, a
  // dependency or an earlier part. v2 makes "no" require something still OPEN.
  v2: {
    describe: "one noul, 'no' only for something still open",
    questions: {
      ready: {
        type: "noul",
        instructions: READINESS_QUESTION.instructions,
        criteria: {
          true:
            "The work to do is identifiable from the issue. Detailed issues that record decisions " +
            "already made, name files, or link related issues for context are ready — detail is " +
            "a sign of readiness, not of risk.",
          false:
            "Something is still OPEN before work can begin: an undecided design or product question, " +
            "a wait on another issue, a third party or a person, or scope so broad it clearly needs " +
            "several pull requests. Mentioning decisions, dependencies or other issues is NOT a " +
            "reason for no when the text already settles them.",
        },
      },
    },
  },
  // Decomposed: one noul per reason, averaged. Each question is narrower, so less room for a
  // literal reading of the combined question.
  v3: {
    describe: "four narrow nouls (clear / one PR / decided / unblocked), mean p",
    questions: {
      clear: {
        type: "noul",
        instructions:
          "The issue says concretely enough what to change that an agent knows when it is done.",
      },
      small: {
        type: "noul",
        instructions: "The work fits in one reviewable pull request.",
        criteria: {
          false: "It is an epic, a multi-phase migration, or needs several pull requests.",
        },
      },
      decided: {
        type: "noul",
        instructions:
          "No design or product decision is still open that a person must make before work starts.",
        criteria: {
          false:
            "The issue itself asks which approach to take, or leaves a choice explicitly undecided. " +
            "Decisions the issue already records do not count.",
        },
      },
      unblocked: {
        type: "noul",
        instructions: "Nothing outside the codebase has to happen first for this work to start.",
        criteria: {
          false:
            "It waits on another open issue, a third party, credentials, infrastructure, or a human action.",
        },
      },
    },
  },
  // Registered as the control (bare instruction, no criteria); it won and is production now.
  v4: {
    describe: "one noul, no criteria (production)",
    questions: { ready: READINESS_QUESTION },
  },
};
