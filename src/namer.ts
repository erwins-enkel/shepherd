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
  "ob",
  "bis",
  "denn",
  "bzw",
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
  "not",
  "no",
  "then",
  "if",
  "as",
  "some",
  "only",
  "there",
  "now",
  "make",
  "add",
  "fix",
  "whether",
  "while",
]);

function transliterate(s: string): string {
  return s.replace(/[äöüßàáâéèêíìóòôúùñç]/gi, (c) => TRANSLIT[c.toLowerCase()] ?? c);
}

/**
 * Slugify a name the human typed deliberately (a manual rename), as opposed to a
 * prompt the heuristic namer mines for a topic. Unlike {@link normalize} this keeps
 * EVERY word — dropping stopwords here would mangle an intentional name like
 * "fix the login bug" into "login-bug". Transliterates accents, lowercases, turns
 * any run of non-alphanumerics into a single dash, trims stray edge dashes, and caps
 * the length so it stays a sane branch/path component. Falls back to "task" when the
 * input reduces to nothing (e.g. all punctuation).
 */
export function slugifyManual(input: string): string {
  const slug = transliterate(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, ""); // a trailing dash can resurface after the length cap
  return slug || "task";
}

// Anchored regex that strips purely imperative command prefixes from the START of a
// prompt (after transliteration + lowercasing). Without this, a prompt such as
// "Prüfe, ob dieses Issue…" would yield "pruefe-ob-issue" — the 3 topical slots are
// wasted on scaffolding words instead of the actual subject. The strip is intentionally
// narrow: it only matches at position 0, removes at most one prefix, and leaves any
// later occurrence of the same word untouched. slugifyManual is NOT affected.
const COMMAND_PREFIX_RE =
  /^(?:pruefe\s+ob|gib\s+mir|kannst\s+du(?:\s+(?:mal|bitte))?|lass\s+uns|ich\s+(?:moechte|will)|schau\s+dir)[,\s]*/;

/**
 * Turn arbitrary prompt text into a short, human-readable kebab-case slug.
 * Transliterates accents, strips filler words, and keeps the first 1–3 topical
 * words — so the name reads like a marker ("scrollen-mausrad-geht") rather than
 * the raw opening of a sentence. Three words (vs two) markedly lowers the chance
 * two distinct prompts collide on the same slug. Falls back to the raw words if
 * filtering wiped everything (a prompt made entirely of stopwords), and to "" if
 * truly empty.
 */
export function normalize(s: string): string {
  const words = transliterate(s)
    .toLowerCase()
    .replace(COMMAND_PREFIX_RE, "") // strip leading imperative boilerplate before tokenizing
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return (meaningful.length ? meaningful : words).slice(0, 3).join("-");
}

/**
 * Derive a session name from a task prompt. Pure and deterministic — no network,
 * no local model. The salient words of a task prompt are already in the prompt,
 * so a heuristic slug matches or beats a local LLM for a 1–3 word name
 * (benchmarked in PR #83) without the RAM/latency cost.
 */
export function generateName(prompt: string): string {
  return normalize(prompt) || "task";
}
