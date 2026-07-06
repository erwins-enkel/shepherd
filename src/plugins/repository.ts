/** Browser-clickable repository URL from optional plugin manifest metadata. */
export function browserRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
