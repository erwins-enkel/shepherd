import type { PendingAsk, VisualBlock } from "#lib/types.js";

type QuestionForm = Extract<VisualBlock, { type: "question-form" }>;

/**
 * An AskUserQuestion dialog (#3165) as the plan gate's question-form block, so the same
 * `QuestionFormBlock` renders it. The block id is the tool_use id and each question id its index —
 * exactly what `POST /api/sessions/:id/answer-ask` resolves against the hooked questions.
 */
export function askToQuestionForm(ask: PendingAsk): QuestionForm {
  return {
    type: "question-form",
    id: ask.toolUseId,
    questions: ask.questions.map((q, i) => ({
      id: q.id ?? String(i),
      prompt: q.question,
      kind: q.kind ?? (q.multiSelect ? "multi" : "single"),
      options: q.options.map((o) => o.label),
      optionDescriptions: q.options.map((o) => o.description),
      header: q.header,
      allowOther: q.kind === "freeform" ? false : (q.allowOther ?? true),
    })),
  };
}
