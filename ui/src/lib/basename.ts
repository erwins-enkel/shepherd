/** Last non-empty path segment (repo display name). */
export function basename(p: string): string {
  return p.split("/").filter(Boolean).at(-1) ?? p;
}
