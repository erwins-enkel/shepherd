export type BlockShape = "menu" | "yes-no" | "awaiting-input";

export interface BlockOption {
  label: string;
  /** Literal text typed into the PTY. The server appends the Enter (`\r`). */
  send: string;
}

export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  /** Last non-empty terminal lines for context; most recent last. */
  tail: string[];
}

const TAIL_LINES = 15;
// Matches "1. Yes", "❯ 2. No", "│  3) Foo" — captures the digit and the label.
const OPTION_RE = /^[\s│|]*[❯>*]?\s*(\d+)[.)]\s+(.*\S)\s*$/;
const YES_NO_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Classify a blocked agent's terminal tail into an actionable shape. Never throws. */
export function classifyBlocked(text: string): BlockReason {
  const tail = text
    .split("\n")
    .map((l) => l.replace(ANSI_RE, "").replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .slice(-TAIL_LINES);

  // Capture the last contiguous 1..n run of numbered options.
  let run: BlockOption[] = [];
  for (const line of tail) {
    const m = OPTION_RE.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === run.length + 1) run.push({ label: m[2]!, send: m[1]! });
    else if (n === 1) run = [{ label: m[2]!, send: m[1]! }];
  }
  if (run.length >= 2) return { shape: "menu", options: run, tail };

  if (tail.some((l) => YES_NO_RE.test(l))) {
    return {
      shape: "yes-no",
      options: [
        { label: "Yes", send: "y" },
        { label: "No", send: "n" },
      ],
      tail,
    };
  }

  return { shape: "awaiting-input", options: [], tail };
}
