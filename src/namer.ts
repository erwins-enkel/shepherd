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
  // Sentence-frame words prose leans on but that name nothing — "could you TAKE a
  // look WHERE…", "KOENNTEST du…". Always dropped; they carry no topic anywhere.
  "take",
  "why",
  "where",
  "weird",
  "after",
  "every",
  "keep",
  "keeps",
  "very",
  "really",
  "warum",
  "waere",
  "koenntest",
  "koennten",
  "wollte",
  "sollten",
  "schauen",
]);

// Frequent-but-dull words: on-topic enough to keep when nothing better exists,
// but they lose to more *specific* terms. Unlike STOPWORDS (always dropped),
// COMMON words are dropped only when at least one specific word survives — so a
// prose prompt names its distinctive subject ("export", not "button"; "scrollen",
// not "geht") while an all-common prompt ("make the button nice") still gets a name.
const COMMON = new Set([
  // English — generic UI / filler / hedging vocabulary
  "button",
  "page",
  "list",
  "item",
  "items",
  "thing",
  "things",
  "app",
  "screen",
  "view",
  "change",
  "new",
  "old",
  "show",
  "display",
  "need",
  "needs",
  "want",
  "wanted",
  "like",
  "nice",
  "little",
  "bit",
  "more",
  "less",
  "better",
  "good",
  "bad",
  "maybe",
  "wonder",
  "wondering",
  "try",
  "trying",
  "get",
  "got",
  "use",
  "using",
  "used",
  "way",
  "ways",
  "user",
  "users",
  "click",
  "stuff",
  "kind",
  "sort",
  "actually",
  "basically",
  "somehow",
  "able",
  "feature",
  "option",
  "options",
  "top",
  "bottom",
  "lot",
  "much",
  // German — generic UI / filler / hedging vocabulary
  "machen",
  "macht",
  "gemacht",
  "gehen",
  "geht",
  "seite",
  "seiten",
  "knopf",
  "liste",
  "listen",
  "sachen",
  "irgendwie",
  "vielleicht",
  "schoen",
  "schoener",
  "besser",
  "klein",
  "gross",
  "neu",
  "anzeigen",
  "zeigen",
  "ansicht",
  "brauche",
  "brauchen",
  "irgendwo",
  "ding",
  "dinge",
  "stelle",
  "funktioniert",
  "funktion",
  "moeglich",
  "wirklich",
  "ziemlich",
  "bisschen",
  "eher",
  "richtig",
  "oben",
  "unten",
  "links",
  "rechts",
  "teil",
  "zusammen",
  "mehr",
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

/**
 * Turn arbitrary prompt text into a short, human-readable kebab-case slug.
 * Transliterates accents, drops stopwords, then selects by *specificity* rather
 * than position: the distinctive words win wherever they sit in the sentence, so
 * prose names its subject ("export-obvious") instead of the dull opening words a
 * positional namer would grab ("wondering-maybe-export"). Common-but-dull words
 * are kept only when nothing more specific survives. Keeps reading order so a
 * multi-word subject stays contiguous, and caps at 4 words. Falls back to the raw
 * words if the stopword filter wiped everything, and to "" if truly empty.
 * Distinctiveness is best-effort, not guaranteed — two prompts can still reduce to
 * the same slug; uniqueName() in service.ts suffixes any clash.
 */
export function normalize(s: string): string {
  const words = transliterate(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const survivors = words.filter((w) => w.length > 1 && !STOPWORDS.has(w));
  // Nothing topical survived (a prompt made entirely of stopwords) — keep the raw
  // opening words rather than emit an empty slug.
  if (!survivors.length) return words.slice(0, 4).join("-");
  // Prefer specific words; drop the merely-common ones unless they're all we have.
  const specific = survivors.filter((w) => !COMMON.has(w));
  const kept = specific.length ? specific : survivors;
  const seen = new Set<string>();
  const unique = kept.filter((w) => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  return unique.slice(0, 4).join("-");
}

/**
 * Derive a session name from a task prompt. Pure and deterministic — no network,
 * no local model. The salient words of a task prompt are already in the prompt,
 * so a heuristic slug matches or beats a local LLM for a 1–4 word name
 * (benchmarked in PR #83) without the RAM/latency cost.
 */
export function generateName(prompt: string): string {
  return normalize(prompt) || "task";
}
