import { config } from "./config";

/** Result of naming a prompt. `source` lets callers/telemetry tell an AI-picked
 *  name apart from the heuristic fallback (used when Ollama is down or the model
 *  is missing) — the UI surfaces "fallback" so silent degradation is visible. */
export interface NameResult {
  name: string;
  source: "ai" | "fallback";
}

// Map the accented letters German (and a few neighbours) prompts carry onto their
// ASCII transliteration BEFORE we strip non-alphanumerics — otherwise "würde"
// becomes the unreadable "w-rde" instead of "wuerde".
const TRANSLIT: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  à: "a",
  á: "a",
  â: "a",
  é: "e",
  è: "e",
  ê: "e",
  í: "i",
  ì: "i",
  ó: "o",
  ò: "o",
  ô: "o",
  ú: "u",
  ù: "u",
  ñ: "n",
  ç: "c",
};

// Filler words (DE + EN) plus common German exclamations that carry no topical
// meaning. Dropping them keeps the subject of the prompt, not the scaffolding:
// "Mist. Scrollen mit dem Mausrad…" → "scrollen-mausrad", not "mist-scrollen-mit-dem".
const STOPWORDS = new Set([
  // German articles / pronouns / prepositions / particles
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "eines",
  "und",
  "oder",
  "aber",
  "mit",
  "fuer",
  "von",
  "vom",
  "zu",
  "zum",
  "zur",
  "im",
  "in",
  "an",
  "auf",
  "aus",
  "bei",
  "nach",
  "ueber",
  "unter",
  "vor",
  "durch",
  "gegen",
  "ohne",
  "um",
  "als",
  "wie",
  "so",
  "dass",
  "wenn",
  "weil",
  "ich",
  "du",
  "er",
  "sie",
  "es",
  "wir",
  "ihr",
  "mich",
  "dich",
  "sich",
  "uns",
  "euch",
  "mir",
  "dir",
  "ihm",
  "ihn",
  "ist",
  "sind",
  "war",
  "waren",
  "bin",
  "bist",
  "sein",
  "seine",
  "haben",
  "hat",
  "hatte",
  "habe",
  "werde",
  "wird",
  "wurde",
  "worden",
  "noch",
  "schon",
  "mal",
  "bitte",
  "gerne",
  "gern",
  "doch",
  "etwas",
  "nur",
  "auch",
  "nicht",
  "kein",
  "keine",
  "dann",
  "hier",
  "da",
  "dort",
  "jetzt",
  "man",
  "moechte",
  "wuerde",
  "koennte",
  "sollte",
  "muss",
  "kann",
  "soll",
  "will",
  "diese",
  "dieser",
  "dieses",
  "mein",
  "meine",
  "dein",
  "deine",
  "alle",
  "alles",
  // German exclamations / filler interjections
  "mist",
  "verdammt",
  "hey",
  "ok",
  "okay",
  "also",
  "halt",
  "eben",
  "einfach",
  "tja",
  "naja",
  "ach",
  // English
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "with",
  "for",
  "of",
  "to",
  "from",
  "in",
  "on",
  "at",
  "by",
  "into",
  "about",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "my",
  "your",
  "our",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "must",
  "just",
  "please",
  "also",
  "not",
  "no",
  "then",
  "if",
  "as",
  "so",
  "some",
  "only",
  "here",
  "there",
  "now",
  "make",
  "add",
  "fix",
  "please",
]);

function transliterate(s: string): string {
  return s.replace(/[äöüßàáâéèêíìóòôúùñç]/gi, (c) => TRANSLIT[c.toLowerCase()] ?? c);
}

/**
 * Turn arbitrary prompt text into a short, human-readable kebab-case slug.
 * Transliterates accents, strips filler words, and keeps the first 1–2 topical
 * words — so the name reads like a marker ("scrollen-mausrad") rather than the
 * raw opening of a sentence. Falls back to the raw words if filtering wiped
 * everything (a prompt made entirely of stopwords), and to "" if truly empty.
 */
export function normalize(s: string): string {
  const words = transliterate(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return (meaningful.length ? meaningful : words).slice(0, 2).join("-");
}

const PROMPT = (p: string) =>
  `Give a 1-2 word kebab-case slug naming the CORE TOPIC of this request. ` +
  `Lowercase, no filler words, no punctuation, reply with ONLY the slug.\nRequest: ${p}`;

export async function generateName(
  prompt: string,
  opts?: { model?: string; endpoint?: string; fetchImpl?: typeof fetch },
): Promise<NameResult> {
  const f = opts?.fetchImpl ?? fetch;
  try {
    const res = await f(opts?.endpoint ?? config.ollamaEndpoint, {
      method: "POST",
      body: JSON.stringify({
        model: opts?.model ?? config.ollamaModel,
        prompt: PROMPT(prompt),
        stream: false,
      }),
    });
    // a missing model returns 404 {error}; treat any non-2xx or error payload as
    // "AI unavailable" so we fall through to the heuristic rather than naming a task "".
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string; error?: string };
    if (data.error) throw new Error(data.error);
    const ai = normalize(data.response ?? "");
    if (ai) return { name: ai, source: "ai" };
  } catch {
    /* fall through to heuristic */
  }
  return { name: normalize(prompt) || "task", source: "fallback" };
}
