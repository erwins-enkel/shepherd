import { resolveAskAnswers, type ResolvedAskAnswer } from "./ask-user-question";
import type { AnswerAskOutcome } from "./ask-answer-service";
import type { RawAnswer } from "./plan-gate";
import type { Session } from "./types";
import type { CodexAsk } from "./codex-question-state";
import type { CodexQuestionTracker } from "./codex-questions";
import {
  codexQuestionHint,
  codexScreenMatches,
  readCodexQuestionScreen,
  type CodexQuestionScreen,
} from "./codex-question-screen";

export interface CodexQuestionTerminal {
  read(): Promise<string | null>;
  send(key: string): Promise<boolean>;
}

export interface CodexQuestionAnswerDeps {
  tracker: CodexQuestionTracker;
  session(id: string): Session | null | undefined;
  /** Holds SessionService's existing steer lock for the entire interaction. */
  withTerminal(
    id: string,
    thread: string,
    run: (terminal: CodexQuestionTerminal) => Promise<AnswerAskOutcome>,
  ): Promise<AnswerAskOutcome | null>;
  gapMs?: number;
  verifyMs?: number;
}

const closed = (): AnswerAskOutcome => ({ ok: false, status: 409, error: "ask_not_open" });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Codex owns its dialog; we only type into a freshly identified, still-open question. */
export class CodexQuestionAnswerService {
  constructor(private deps: CodexQuestionAnswerDeps) {}

  async answer(id: string, requestId: string, raw: RawAnswer[]): Promise<AnswerAskOutcome> {
    const s = this.deps.session(id);
    if (!s?.providerSessionId || s.agentProvider !== "codex") return closed();
    return (
      (await this.deps.withTerminal(id, s.providerSessionId, async (terminal) => {
        let activeIndex: number | null = null;
        const read = async () => {
          const live = this.deps.session(id);
          if (
            !live ||
            live.providerSessionId !== s.providerSessionId ||
            live.herdrAgentId !== s.herdrAgentId
          )
            return null;
          const text = await terminal.read();
          if (text === null) return null;
          await this.deps.tracker.refresh(live);
          this.deps.tracker.observe(live, text);
          const current = this.deps.tracker.get(live, requestId);
          if (!current || (activeIndex !== null && !current.indices.includes(activeIndex)))
            return null;
          return text;
        };
        if ((await read()) === null) return closed();
        const ask = this.deps.tracker.get(s, requestId);
        if (!ask) return closed();
        const answers = resolveAskAnswers(ask.questions, raw);
        if (!answers) return { ok: false, status: 400, error: "invalid answers" };
        const io = {
          read,
          send: async (key: string) => {
            const sent = await terminal.send(key);
            await pause(this.deps.gapMs ?? 180);
            return sent;
          },
        };
        for (const [i, answer] of answers.entries()) {
          activeIndex = ask.indices[i]!;
          if (!(await this.show(io, ask, answer, i))) return closed();
          if (!(await this.type(io, ask, answer))) return closed();
          if (ask.mode === "async") {
            const verdict = await this.verify(s, ask, i, answer);
            if (verdict !== "verified") return { ok: true, result: verdict };
          }
        }
        return this.verifyAll(s, ask, answers);
      })) ?? closed()
    );
  }

  private async show(
    io: CodexQuestionTerminal,
    ask: CodexAsk,
    answer: ResolvedAskAnswer,
    position: number,
  ): Promise<boolean> {
    if (!(await this.openQueue(io, ask.mode))) return false;
    let forward = false;
    for (let step = 0; step < 40; step++) {
      const text = await io.read();
      if (text === null) return false;
      const screen = readCodexQuestionScreen(text);
      if (screen?.mode === ask.mode && codexScreenMatches(screen, answer.question.question))
        return true;
      if (!screen || screen.mode !== ask.mode || screen.notes) return false;
      if (screen.index === 0) forward = true;
      const key = this.navigationKey(screen, position, forward);
      if (!(await io.send(key))) return false;
    }
    return false;
  }

  private async openQueue(io: CodexQuestionTerminal, mode: CodexAsk["mode"]): Promise<boolean> {
    const text = await io.read();
    if (text === null) return false;
    const hint = codexQuestionHint(text);
    return mode === "async" && hint ? io.send(hint.key) : true;
  }

  private navigationKey(screen: CodexQuestionScreen, position: number, forward: boolean): string {
    if (screen.mode === "sync") return screen.index < position ? "\x1b[C" : "\x1b[D";
    return forward ? "\x1b[1;2D" : "\x1b[1;2C";
  }

  private async current(
    io: CodexQuestionTerminal,
    ask: CodexAsk,
    answer: ResolvedAskAnswer,
  ): Promise<CodexQuestionScreen | null> {
    const text = await io.read();
    const screen = text === null ? null : readCodexQuestionScreen(text);
    // Sync replies are only persisted when the whole dialog completes. Its unanswered counter
    // detects a manual partial answer, so we cannot overwrite it while navigating earlier pages.
    if (
      screen?.mode === "sync" &&
      screen.unanswered !== ask.questions.length - Number(answer.question.id)
    )
      return null;
    return screen?.mode === ask.mode && codexScreenMatches(screen, answer.question.question)
      ? screen
      : null;
  }

  private async type(
    io: CodexQuestionTerminal,
    ask: CodexAsk,
    answer: ResolvedAskAnswer,
  ): Promise<boolean> {
    let screen = await this.current(io, ask, answer);
    if (!screen || screen.notes) return false;
    if (!answer.other)
      return (
        screen.selected !== null &&
        screen.selected < answer.question.options.length &&
        io.send(String(answer.optionIndices[0]! + 1))
      );
    if (!(await this.openOther(io, ask, answer, screen))) return false;
    screen = await this.current(io, ask, answer);
    if (!screen || (ask.mode === "sync" && !screen.notes)) return false;
    if (ask.mode === "async" && !this.emptyAsyncInput(screen)) return false;
    if (!(await io.send(`\x1b[200~${answer.other}\x1b[201~`))) return false;
    // Keep the dialog identity check after the paste; a concurrent native answer must not
    // turn our trailing Enter into a new prompt submission.
    if (!(await this.current(io, ask, answer))) return false;
    return io.send("\r");
  }

  private async openOther(
    io: CodexQuestionTerminal,
    ask: CodexAsk,
    answer: ResolvedAskAnswer,
    screen: CodexQuestionScreen,
  ): Promise<boolean> {
    const count = answer.question.options.length;
    if (!count) return true;
    if (ask.mode === "async") return screen.selected === count || io.send(String(count + 1));
    // Digits submit immediately. Move onto None of the above before opening notes.
    for (let n = 0; n <= count; n++) {
      const current = await this.current(io, ask, answer);
      if (!current || current.selected === null || current.notes) return false;
      if (current.selected === count) return io.send("\t");
      if (!(await io.send("\x1b[B"))) return false;
    }
    return false;
  }

  private emptyAsyncInput(screen: CodexQuestionScreen): boolean {
    // Preserve a draft the operator already typed in the native input.
    const lines = screen.body.trim().split("\n");
    const lastOption = lines.findLastIndex((line) => /^\s*[›❯>]?\s*\d+\. /.test(line));
    const input =
      lastOption >= 0
        ? lines
            .slice(lastOption + 1)
            .join("\n")
            .trim()
        : screen.body
            .trim()
            .split(/\n[ \t]*\n/)
            .at(-1)
            ?.trim();
    return !input || input === "Type your answer";
  }

  private async verifyAll(
    s: Session,
    ask: CodexAsk,
    answers: ResolvedAskAnswer[],
  ): Promise<AnswerAskOutcome> {
    for (const [i, answer] of answers.entries()) {
      const verdict = await this.verify(s, ask, i, answer);
      if (verdict !== "verified") return { ok: true, result: verdict };
    }
    return { ok: true, result: "verified" };
  }

  private async verify(
    s: Session,
    ask: CodexAsk,
    position: number,
    answer: ResolvedAskAnswer,
  ): Promise<"verified" | "mismatch" | "unverified"> {
    const expected = answer.other
      ? ask.mode === "sync"
        ? ["None of the above", `user_note: ${answer.other}`]
        : [answer.other]
      : [answer.question.options[answer.optionIndices[0]!]!.label];
    const end = Date.now() + (this.deps.verifyMs ?? 10_000);
    do {
      const live = this.deps.session(s.id);
      if (
        !live ||
        live.providerSessionId !== s.providerSessionId ||
        live.herdrAgentId !== s.herdrAgentId
      )
        return "unverified";
      await this.deps.tracker.refresh(live);
      const actual = this.deps.tracker.answer(live, ask.toolUseId, ask.indices[position]!);
      if (actual)
        return JSON.stringify(actual) === JSON.stringify(expected) ? "verified" : "mismatch";
      await pause(this.deps.gapMs ?? 180);
    } while (Date.now() < end);
    return "unverified";
  }
}
