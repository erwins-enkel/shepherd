import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ThemeRegistrationAny,
} from "shiki";
import { langFromPath } from "./diff";

// Hand-tuned dark theme matching the HUD palette (Shiki needs concrete hex, not
// CSS vars). Mirrors app.css --ink/--muted/--amber/--green/--blue/--red.
const SHEPHERD_DARK = {
  name: "shepherd-dark",
  type: "dark" as const,
  colors: { "editor.background": "#0f1413", "editor.foreground": "#c4d0cb" },
  settings: [
    { settings: { foreground: "#c4d0cb" } },
    { scope: ["comment"], settings: { foreground: "#7c8c86" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#5ad19a" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#e8a13a" } },
    { scope: ["keyword", "storage", "storage.type"], settings: { foreground: "#4a90d9" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#e8a13a" } },
    {
      scope: ["entity.name.type", "support.type", "support.class"],
      settings: { foreground: "#5ad19a" },
    },
    { scope: ["variable", "meta.definition.variable"], settings: { foreground: "#c4d0cb" } },
    { scope: ["invalid", "keyword.operator"], settings: { foreground: "#e5484d" } },
  ],
};

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "svelte",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "bash",
  "yaml",
  "toml",
];

let hlPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!hlPromise) {
    hlPromise = createHighlighter({
      themes: [SHEPHERD_DARK as ThemeRegistrationAny],
      langs: LANGS,
    });
  }
  return hlPromise;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlight a file's diff-line contents (in render order) to per-line HTML.
 * One Shiki call per file: join with \n, tokenize once, map tokens back per line.
 * Unknown language → escaped plain text (the +/- coloring still applies in CSS).
 * Per-line tokenization caveat (multi-line constructs) is accepted for review.
 */
export async function highlightLines(contents: string[], path: string): Promise<string[]> {
  const lang = langFromPath(path);
  if (lang === "text") return contents.map(escapeHtml);
  try {
    const hl = await getHighlighter();
    const { tokens } = hl.codeToTokens(contents.join("\n"), {
      lang: lang as BundledLanguage,
      theme: "shepherd-dark",
    });
    return tokens.map((line) =>
      line
        .map((t) => `<span style="color:${t.color ?? "inherit"}">${escapeHtml(t.content)}</span>`)
        .join(""),
    );
  } catch {
    return contents.map(escapeHtml); // unknown lang / load failure → plain
  }
}
