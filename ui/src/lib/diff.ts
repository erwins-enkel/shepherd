import type { DiffFile } from "./types";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  svelte: "svelte",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

/** Map a file path to a Shiki language id; "text" when unknown (no highlighting). */
export function langFromPath(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "text";
  return EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? "text";
}

/** Aggregate file count + added/removed line totals for the panel header. */
export function diffTotals(files: DiffFile[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}
