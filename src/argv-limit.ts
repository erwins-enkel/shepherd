import { sanitizePromptArg } from "./transient-agent-argv";

/** Linux caps a SINGLE argv element at `MAX_ARG_STRLEN`, hard-coded in the kernel as
 *  `PAGE_SIZE * 32` (`include/uapi/linux/binfmts.h`) — 128 KiB on the ubiquitous 4 KiB page.
 *  Exceeding it fails the `execve` with `E2BIG` no matter how much of the whole-argv budget
 *  (`ARG_MAX` / `RLIMIT_STACK / 4`) is free. That is the failure in issue #1944: the transient
 *  agent's entire prompt rides as the trailing argv positional.
 *
 *  PINNED, NOT PROBED. No `node:os` API exposes a page size and nothing in this repo reads one, so
 *  there is no production source for it — an optional-and-nullable parameter would let a mis-wired
 *  call resolve the limit to `Infinity` and silently disable the whole guard on Linux, while every
 *  test that injects a value still passed. So `pageSize` is a DEFAULTED parameter that production
 *  never passes, typed `number` and never `number | null`.
 *
 *  On a 16 KiB / 64 KiB-page kernel (some arm64) the real cap is 512 KiB / 2 MiB and this
 *  under-estimates it, so the ladder clamps earlier than strictly necessary. That is the only safe
 *  direction — it can never let an over-limit argv through — and {@link OversizedArgvError} maps
 *  the kernel's own verdict for whatever is left over. */
export const LINUX_PAGE_SIZE_BYTES = 4096;

/** Bytes permitted in one argv element, or `Infinity` where the OS has no per-element cap.
 *  Darwin caps only the WHOLE argv (`kern.argmax`), not each element, so nothing is clamped there
 *  and the spawn path stays byte-identical. */
export function argvElementLimit(
  platform: string,
  pageSize: number = LINUX_PAGE_SIZE_BYTES,
): number {
  return platform === "linux" ? pageSize * 32 : Number.POSITIVE_INFINITY;
}

/** The limit as PRODUCTION computes it: real platform, pinned page size, no injection. Tests
 *  assert this resolves to 131072 on Linux — a mis-wire that yielded `Infinity` here would leave
 *  every injected-value test passing while the guard did nothing. */
export function hostArgvElementLimit(): number {
  return argvElementLimit(process.platform);
}

/** One byte of headroom under the limit, so an argv sized exactly at the budget is accepted and
 *  the off-by-one can never land on the failing side. `Infinity` off Linux. */
export function hostArgvBudget(): number {
  const limit = hostArgvElementLimit();
  return Number.isFinite(limit) ? limit - 1 : limit;
}

/** Single-quote every token so a POSIX shell reconstructs the exact argv. Lives here rather than
 *  in `herdr.ts` because {@link joinedElementBytes} depends on it and `herdr.ts` depends on
 *  {@link OversizedArgvError} — `herdr.ts` re-exports it, so existing importers are unaffected. */
export function posixShellJoin(argv: string[]): string {
  return argv.map((tok) => `'${tok.replaceAll("'", `'\\''`)}'`).join(" ");
}

/** Bytes one token costs INSIDE a joined command line — measured on the string that actually
 *  ships, not on the raw input. Two renderings grow it and a naive `Buffer.byteLength` would miss
 *  both: `posixShellJoin` adds the two wrapping quotes (+2) and expands each embedded `'` to
 *  `'\''` (+3 each), and `sanitizePromptArg` expands each NUL to `\0` (+1 each). An
 *  apostrophe-dense plan can therefore exceed a naive count by several percent — enough, at this
 *  scale, to be the difference between fitting and `E2BIG`. */
export function joinedElementBytes(s: string): number {
  return Buffer.byteLength(posixShellJoin([sanitizePromptArg(s)]), "utf8");
}

/** Bytes the WHOLE argv costs once joined into a single shell command line — the exact quantity
 *  the herdr 0.7.5 `pane run` / `pane.send_text` paths push through one argv element. On the
 *  ≤0.7.4 spread paths each token is its own element, so this over-counts; that errs toward
 *  clamping early and never toward `E2BIG`. */
export function spawnFootprintBytes(argv: string[]): number {
  let total = 0;
  for (const tok of argv) total += joinedElementBytes(tok);
  return total + Math.max(0, argv.length - 1); // the separating spaces
}

/** A spawn that failed (or would fail) because one argv element exceeds the OS limit. Raised by
 *  the herdr runner factories in place of a bare `E2BIG`, whose default rendering
 *  (`spawn herdr E2BIG`) named neither the cause nor the cure. */
export class OversizedArgvError extends Error {
  readonly bytes: number | null;
  readonly limit: number;

  constructor(message: string, opts: { bytes?: number | null; limit?: number; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OversizedArgvError";
    this.bytes = opts.bytes ?? null;
    this.limit = opts.limit ?? hostArgvElementLimit();
  }
}

/** Map a caught spawn error to {@link OversizedArgvError} when the kernel said `E2BIG`, else null.
 *  Uses the OS's own verdict rather than a predicted limit, so it can never over-refuse an argv a
 *  large-page kernel would have accepted. */
export function oversizedFromArgv(err: unknown, argv: string[]): OversizedArgvError | null {
  if (!err || typeof err !== "object" || (err as { code?: unknown }).code !== "E2BIG") return null;
  const bytes = spawnFootprintBytes(argv);
  return new OversizedArgvError(
    `spawn argv exceeds the OS per-argument limit (~${bytes} bytes joined, limit ${hostArgvElementLimit()}); ` +
      `the prompt is too large to pass on the command line`,
    { bytes, cause: err },
  );
}

/** Proactive per-element check for paths that cannot surface a kernel `E2BIG` (the socket driver
 *  hands the argv to a daemon, which fails opaquely). Throws {@link OversizedArgvError}. */
export function assertArgvWithinLimit(argv: string[], context: string): void {
  // Compare against the BUDGET, not the raw limit: the kernel checks MAX_ARG_STRLEN against the
  // string including its NUL terminator, so an element of exactly `limit` bytes already fails
  // (verified against the real kernel in test/spawn-e2big.test.ts).
  const budget = hostArgvBudget();
  if (!Number.isFinite(budget)) return;
  for (const tok of argv) {
    const bytes = Buffer.byteLength(tok, "utf8");
    if (bytes > budget) {
      throw new OversizedArgvError(
        `${context}: argv element of ${bytes} bytes exceeds the OS per-argument limit of ${hostArgvElementLimit()}`,
        { bytes },
      );
    }
  }
}
