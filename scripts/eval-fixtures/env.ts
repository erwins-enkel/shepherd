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

/** A fake worktree root. The reviewer orients itself with `pwd` / `git rev-parse --show-toplevel`
 *  before it does anything else; answering those with silence reads as a broken shell. */
const WORKTREE = "/tmp/shepherd-review-wt";
/** Any ref the reviewer resolves answers with this. Fixed, so renders stay deterministic. */
const HEAD_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Files the DIFF adds, reconstructed from its `+` lines. In production the PR branch is checked
 * out, so a file the diff creates is readable — a fixture that answers "does not exist" for the
 * very file under review sends the reviewer hunting for a tree it will never find. Only ADDED
 * files are reconstructed (their `+` lines are the whole content); a modified file's post-image
 * cannot be recovered from the diff alone, so fixtures supply those through `files`.
 */
function addedFiles(diff: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const path = /^a\/\S+ b\/(\S+)/.exec(chunk)?.[1];
    // `--- /dev/null` is what marks a creation; anything else is a modification.
    if (!path || !/^--- \/dev\/null$/m.test(chunk)) continue;
    const body = chunk
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
    if (body) out[path] = `${body}\n`;
  }
  return out;
}

/** Every path the reviewer can see: what the fixture supplies, plus what the diff creates. */
function tree(env: FixtureEnv): Record<string, string> {
  return { ...addedFiles(env.diff ?? ""), ...(env.files ?? {}) };
}

const MAX_GREP_MATCHES = 40;

function readFile(env: FixtureEnv, filePath: unknown): string {
  if (typeof filePath !== "string") return "Error: file_path must be a string.";
  // Tolerate `./x`, `/abs/x` and bare `x` for the same fixture key — a model may address the file
  // any of those ways, and the fixture map is keyed repo-relative.
  const candidates = [filePath, filePath.replace(/^\.\//, ""), filePath.replace(/^\/+/, "")];
  const files = tree(env);
  for (const key of candidates) {
    const hit = files[key];
    if (hit !== undefined) return hit;
  }
  // Last resort: a reviewer may address the file by its worktree-absolute path
  // (`/tmp/wt-1234/src/x.ts`). Match on a full path SUFFIX at a `/` boundary so `x.ts` alone never
  // resolves `src/x.ts` — that would answer a question the reviewer did not ask.
  const suffixHit = Object.entries(files).find(([key]) => filePath.endsWith(`/${key}`));
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
  for (const [file, content] of Object.entries(tree(env))) {
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

/**
 * A SMALL, PLAUSIBLE shell over the fixture environment.
 *
 * It models more than the prompts literally ask for, and that is the point. A trace of a real trial
 * showed the reviewer opening with `pwd`, `git rev-parse --show-toplevel`, `ls -la`, `echo test123`
 * — basic orientation — and getting "(no output)" from every one. It reasonably concluded the shell
 * was broken and burned 15 of its 18 turns trying to find a working one, writing its review only as
 * the budget ran out. Silence from `pwd` is not neutral; it actively misleads.
 *
 * So: answer what an agent actually opens with, compound commands included. This is scaffolding,
 * not review guidance — none of it says anything about the diff.
 */
function bash(env: FixtureEnv, command: unknown): string {
  if (typeof command !== "string") return "Error: command must be a string.";
  // Evaluate `a; b && c` piecewise and concatenate, dropping `cd …` (there is one tree here).
  const parts = command
    .split(/;|&&|\|\|/)
    .map((p) => p.trim())
    .filter((p) => p !== "" && !/^cd\b/.test(p));
  const outputs = parts.map((part) => runOne(env, part)).filter((o) => o !== "");
  return outputs.length > 0 ? outputs.join("\n") : "(no output)";
}

function runOne(env: FixtureEnv, command: string): string {
  const paths = Object.keys(tree(env)).sort();

  // Orientation — the commands an agent opens with.
  if (/^pwd\b/.test(command)) return WORKTREE;
  if (/\bgit\s+rev-parse\b/.test(command)) {
    if (/--show-toplevel/.test(command)) return WORKTREE;
    // A ref must RESOLVE. Answering "HEAD" to `git rev-parse --verify origin/main` reads as a
    // missing base, and a reviewer told its base is missing goes looking for the repository
    // instead of reviewing — nine turns of `.git/packed-refs` and `find /` in an observed trace.
    return HEAD_SHA;
  }
  if (/\bgit\s+(remote)\b/.test(command)) return `origin\t${WORKTREE} (fetch)`;
  if (/\bgit\s+(show-ref|cat-file)\b/.test(command)) {
    return /cat-file\s+-t/.test(command) ? "commit" : `${HEAD_SHA} refs/heads/review-branch`;
  }
  if (/\bgit\s+ls-tree\b/.test(command)) {
    const paths = Object.keys(tree(env)).sort();
    return paths.length > 0 ? paths.join("\n") : "(no output)";
  }
  if (/^echo\b/.test(command)) {
    return command
      .replace(/^echo\s+/, "")
      .replace(/\s*\d?>&?\d?\s*$/, "")
      .replace(/^["']|["']$/g, "");
  }
  if (/\bgit\s+branch\b/.test(command)) return "* review-branch\n  main";
  if (/\bgit\s+status\b/.test(command)) {
    return "On branch review-branch\nnothing to commit, working tree clean";
  }

  // The reviewed change.
  if (/\bgit\s+diff\b/.test(command)) {
    if (/--stat\b/.test(command)) {
      const changed = new Set<string>();
      for (const line of (env.diff ?? "").split("\n")) {
        const m = /^diff --git a\/\S+ b\/(\S+)/.exec(line);
        if (m?.[1]) changed.add(m[1]);
      }
      return changed.size > 0 ? [...changed].map((f) => ` ${f} | +++`).join("\n") : "(no output)";
    }
    return env.diff ?? "(no changes)";
  }
  if (/\bgit\s+(log|show)\b/.test(command)) {
    // A repository with no history reads as broken; one plausible commit is enough to settle it.
    return `${HEAD_SHA.slice(0, 8)} the change under review`;
  }

  // Listing.
  if (/^(ls|find)\b/.test(command) || /\bgit\s+ls-files\b/.test(command)) {
    return paths.length > 0 ? paths.join("\n") : "(no output)";
  }

  // Searching.
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

  if (/^cat\b/.test(command)) {
    const file = tokenize(command)[1];
    return file === undefined ? "(no output)" : readFile(env, file);
  }

  return "";
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
