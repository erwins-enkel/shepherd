/**
 * Pure helpers shared by the page-side recorder (src/recorder.ts). Kept free of
 * `window`/`chrome` so they are unit-testable; the recorder glue that wraps
 * console/fetch/XHR delegates its buffer + classification decisions here.
 */

/** Push onto a ring buffer, dropping the oldest entries once it exceeds `cap`. */
export function pushCapped<T>(buf: T[], entry: T, cap: number): void {
  buf.push(entry);
  while (buf.length > cap) buf.shift();
}

/** A response counts as a recordable failure once its status is ≥400. */
export function isFailedResponse(status: number): boolean {
  return status >= 400;
}

/** Collapse console arguments into one readable line. */
export function normalizeConsoleArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}
