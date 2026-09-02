// The in-memory fixture ENVIRONMENT shared by the plan-gate and critic evals (issue #2156).
//
// Both prompts tell a reviewer it is sitting in a checked-out worktree: the critic orders
// `git diff <base>...HEAD` and greps the tree to confirm identifiers exist; the plan-gate reviewer
// MAY inspect the codebase read-only. A single Messages call cannot serve that, so the harness
// declares `Bash`/`Read`/`Grep` and answers each call from the fixture's own `{ diff, files }` map.
//
// Two properties this buys, both deliberate:
//   - The production prompt is imported UNCHANGED. Nothing is rewritten to inline the diff, so the
//     eval measures the prompt that ships.
//   - No model-authored shell is ever executed. Fixture content is untrusted by construction (some
//     fixtures deliberately carry injection-shaped text), so running its commands would be exactly
//     the wrong move.
//
// A path the map does not carry answers "does not exist" — the same answer a real tree gives for a
// file it does not have. Fixtures therefore keep their file maps small and self-contained: whatever
// a reviewer might reasonably want to check is either present or genuinely absent.

export interface FixtureEnv {
  /** What `git diff <base>...HEAD` returns. Absent -> empty (no changes). */
  diff?: string;
  /** Repo-relative path -> file content. Absent paths answer "does not exist". */
  files?: Record<string, string>;
}

const MAX_GREP_MATCHES = 40;

function readFile(env: FixtureEnv, filePath: unknown): string {
  if (typeof filePath !== "string") return "Error: file_path must be a string.";
  // Tolerate `./x`, `/abs/x` and bare `x` for the same fixture key — a model may address the file
  // any of those ways, and the fixture map is keyed repo-relative.
  const candidates = [filePath, filePath.replace(/^\.\//, ""), filePath.replace(/^\/+/, "")];
  const files = env.files ?? {};
  for (const key of candidates) {
    const hit = files[key];
    if (hit !== undefined) return hit;
  }
  // Last resort: a reviewer may address the file by its worktree-absolute path
  // (`/tmp/wt-1234/src/x.ts`). Match on a full path SUFFIX at a `/` boundary so `x.ts` alone never
  // resolves `src/x.ts` — that would answer a question the reviewer did not ask.
  const suffixHit = Object.entries(env.files ?? {}).find(([key]) => filePath.endsWith(`/${key}`));
  if (suffixHit) return suffixHit[1];
  return `Error: ${filePath} does not exist.`;
}

function grep(env: FixtureEnv, pattern: unknown, path: unknown): string {
  if (typeof pattern !== "string") return "Error: pattern must be a string.";
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return `Error: invalid regular expression: ${pattern}`;
  }
  const scope = typeof path === "string" && path.trim() !== "" ? path.replace(/^\.\//, "") : null;
  const out: string[] = [];
  for (const [file, content] of Object.entries(env.files ?? {})) {
    if (scope && !file.startsWith(scope)) continue;
    content.split("\n").forEach((line, i) => {
      if (out.length < MAX_GREP_MATCHES && re.test(line)) out.push(`${file}:${i + 1}:${line}`);
    });
  }
  return out.length > 0 ? out.join("\n") : "No matches found.";
}

/** Split a command line into arguments, honouring single and double quotes. Not a shell parser —
 *  just enough that a quoted pattern stays one token. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

function bash(env: FixtureEnv, command: unknown): string {
  if (typeof command !== "string") return "Error: command must be a string.";
  // Only the read-only git verbs the prompts actually name are modelled. Everything else answers
  // empty, which is what an unrecognised command's stdout would look like to the reader anyway.
  if (/\bgit\s+diff\b/.test(command)) return env.diff ?? "(no changes)";
  if (/\bgit\s+(log|show|status)\b/.test(command)) return "(no output)";
  if (/^\s*(ls|find)\b/.test(command)) {
    const paths = Object.keys(env.files ?? {});
    return paths.length > 0 ? paths.join("\n") : "(no output)";
  }
  if (/\b(rg|grep)\b/.test(command)) {
    // `rg <pattern> [path]`, `grep -r <pattern> [path]`, `git grep '<pattern>' [path]`. Tokenized
    // quote-aware: a quoted multi-word pattern must survive as ONE argument, or its tail would be
    // read as a path and the search would answer a spurious "No matches found." — which could talk
    // a reviewer into a false finding.
    const args = tokenize(command).filter(
      (a) => !a.startsWith("-") && !/^(git|rg|grep|egrep|fgrep)$/.test(a),
    );
    return grep(env, args[0], args[1]);
  }
  // Anything not modelled: an EMPTY tool_result reads as a malfunction and invites the model to try
  // again a different way, burning the turn budget. Say what a shell says when a command is quiet.
  return "(no output)";
}

/** Answer one tool call from the fixture environment. Unknown tools answer empty. */
export function respondFromEnv(
  env: FixtureEnv,
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name.toLowerCase()) {
    case "bash":
      return bash(env, input.command);
    case "read":
      return readFile(env, input.file_path);
    case "grep":
      return grep(env, input.pattern, input.path);
    default:
      return "";
  }
}
