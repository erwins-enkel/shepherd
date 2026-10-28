import type { AskQuestion, PendingAsk } from "./ask-user-question";
import {
  codexQuestionHint,
  codexScreenMatches,
  readCodexQuestionScreen,
} from "./codex-question-screen";

export interface CodexAsk extends PendingAsk {
  mode: "sync" | "async";
  /** Original positions survive partial asynchronous answers. Never use a shrinking array index. */
  indices: number[];
  nativeIds: string[];
}

interface Request {
  id: string;
  mode: "sync" | "async";
  questions: AskQuestion[];
  nativeIds: string[];
  answers: Map<number, string[]>;
  closed: boolean;
}

const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const json = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

function parseQuestions(
  value: unknown,
  mode: Request["mode"],
): { questions: AskQuestion[]; nativeIds: string[] } | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const questions: AskQuestion[] = [];
  const nativeIds: string[] = [];
  for (const raw of value) {
    const parsed = parseQuestion(raw, mode, nativeIds.length);
    if (!parsed || nativeIds.includes(parsed.nativeId)) return null;
    questions.push(parsed.question);
    nativeIds.push(parsed.nativeId);
  }
  return { questions, nativeIds };
}

function parseQuestion(
  raw: unknown,
  mode: Request["mode"],
  index: number,
): { question: AskQuestion; nativeId: string } | null {
  const q = object(raw);
  const question = q?.[mode === "async" ? "title" : "question"];
  if (!q || typeof question !== "string" || !question.trim() || q.isSecret === true) return null;
  const nativeId = mode === "async" ? String(index) : q.id;
  if (typeof nativeId !== "string") return null;
  const options = parseOptions(q.options, mode);
  if (!options) return null;
  return {
    nativeId,
    question: {
      id: String(index),
      question,
      header: typeof q.header === "string" ? q.header : "",
      options,
      multiSelect: false,
      kind: options.length ? "single" : "freeform",
      allowOther: true,
    },
  };
}

function parseOptions(value: unknown, mode: Request["mode"]): AskQuestion["options"] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const options: AskQuestion["options"] = [];
  for (const raw of value) {
    const opt = mode === "async" ? { label: raw, description: "" } : object(raw);
    if (!opt || typeof opt.label !== "string" || !opt.label.trim()) return null;
    options.push({
      label: opt.label,
      description: typeof opt.description === "string" ? opt.description : "",
    });
  }
  return options;
}

/** Rollout evidence only. A candidate is not actionable until corroborated by the live TUI. */
export class CodexQuestionState {
  private requests = new Map<string, Request>();

  ingest(raw: unknown): void {
    const record = object(raw);
    const p = object(record?.payload);
    if (!p) return;
    if (record?.type === "response_item") this.response(p);
    if (record?.type === "event_msg") this.event(p);
  }

  private event(p: Record<string, unknown>): void {
    if (p.type === "task_started") {
      // A new native turn replaces the previous TUI turn's question controls. A user message
      // delivered into a running turn is not task_started and does not clear its requests.
      for (const r of this.requests.values()) r.closed = true;
    }
    if (p.type === "turn_aborted") {
      for (const r of this.requests.values()) if (r.mode === "sync") r.closed = true;
    }
    if (p.type !== "item_completed") return;
    const item = object(p.item);
    if (item?.type === "AgentMessage" && item.delivery === "async")
      this.add(item.id, item.questions, "async");
    if (item?.type === "UserMessage") this.userContent(item.content);
  }

  private response(p: Record<string, unknown>): void {
    if (p.type === "function_call") {
      const mode =
        p.name === "request_user_input_async"
          ? "async"
          : p.name === "request_user_input"
            ? "sync"
            : null;
      if (mode) this.add(p.call_id, object(json(p.arguments))?.questions, mode);
    } else if (p.type === "function_call_output" && typeof p.call_id === "string") {
      this.syncReply(p.call_id, p.output);
    } else if (p.type === "message" && p.role === "user") this.userContent(p.content);
  }

  private syncReply(id: string, output: unknown): void {
    const r = this.requests.get(id);
    if (!r || r.mode !== "sync") return; // async accepted is only acknowledgement
    const answers = object(object(json(output))?.answers) ?? {};
    for (const [index, questionId] of r.nativeIds.entries()) {
      const a = object(answers[questionId])?.answers;
      if (Array.isArray(a) && a.every((v) => typeof v === "string")) r.answers.set(index, a);
    }
    r.closed = true; // a native sync result, including cancellation, ends its dialog
  }

  private add(id: unknown, input: unknown, mode: Request["mode"]): void {
    if (typeof id !== "string" || !id || this.requests.has(id)) return;
    const parsed = parseQuestions(input, mode);
    if (parsed) this.requests.set(id, { id, mode, ...parsed, answers: new Map(), closed: false });
  }

  private userContent(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = object(block);
      if (!b || !["text", "input_text"].includes(String(b.type)) || typeof b.text !== "string")
        continue;
      const m =
        /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(
          b.text,
        );
      const replies = m ? json(m[1]) : null;
      if (Array.isArray(replies)) for (const reply of replies) this.asyncReply(reply);
    }
  }

  private asyncReply(raw: unknown): void {
    const reply = object(raw);
    const key = json(reply?.questionItemId);
    if (!reply || !Array.isArray(key) || key.length !== 3 || key[0] !== "request_user_input_async")
      return;
    const r = this.requests.get(key[1]);
    const index = key[2];
    if (
      !r ||
      r.mode !== "async" ||
      !Number.isInteger(index) ||
      index < 0 ||
      r.questions[index]?.question !== reply.question ||
      typeof reply.answer !== "string"
    )
      return;
    r.answers.set(index, [reply.answer]);
  }

  candidates(): CodexAsk[] {
    return [...this.requests.values()]
      .filter((r) => !r.closed)
      .flatMap((r) => {
        const indices = r.questions.map((_, i) => i).filter((i) => !r.answers.has(i));
        return indices.length
          ? [
              {
                toolUseId: r.id,
                mode: r.mode,
                indices,
                nativeIds: indices.map((i) => r.nativeIds[i]!),
                questions: indices.map((i) => r.questions[i]!),
              },
            ]
          : [];
      });
  }

  answer(id: string, index: number): string[] | null {
    return this.requests.get(id)?.answers.get(index) ?? null;
  }

  visible(text: string): CodexAsk[] {
    const candidates = this.candidates();
    const hint = codexQuestionHint(text);
    const screen = readCodexQuestionScreen(text);
    const async = candidates.filter((r) => r.mode === "async");
    if (hint && async.reduce((n, r) => n + r.questions.length, 0) === hint.count) return async;
    if (!screen) return [];
    const sameMode = candidates.filter((r) => r.mode === screen.mode);
    const matching = sameMode.flatMap((r) =>
      r.questions.flatMap((q, i) => (codexScreenMatches(screen, q.question) ? [{ r, i }] : [])),
    );
    if (matching.length !== 1) return [];
    const { r, i } = matching[0]!;
    if (screen.mode === "sync")
      return r.questions.length === screen.count && i === screen.index ? [r] : [];
    if (async.reduce((n, a) => n + a.questions.length, 0) === screen.count) return async;
    // A locally skipped sibling has no rollout event. A sole, uniquely matched live question
    // is still identifiable; never guess the identities of an incomplete multi-question queue.
    return screen.count === 1
      ? [
          {
            ...r,
            questions: [r.questions[i]!],
            indices: [r.indices[i]!],
            nativeIds: [r.nativeIds[i]!],
          },
        ]
      : [];
  }
}
