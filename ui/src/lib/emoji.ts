export interface EmojiEntry {
  char: string;
  keywords: string;
}

// Curated set tuned for software projects. The paste field covers the long tail,
// so this only needs the common picks — not the whole Unicode emoji table.
export const EMOJI: EmojiEntry[] = [
  { char: "📦", keywords: "package box module library bundle" },
  { char: "🚀", keywords: "rocket launch ship deploy fast" },
  { char: "🔐", keywords: "lock auth security secret login" },
  { char: "🔑", keywords: "key auth token credential" },
  { char: "🛡️", keywords: "shield security guard protect" },
  { char: "🤖", keywords: "robot bot agent ai automation" },
  { char: "🧠", keywords: "brain ai ml model think" },
  { char: "🧪", keywords: "test lab experiment tube" },
  { char: "🧬", keywords: "dna bio science" },
  { char: "🎨", keywords: "art design palette ui paint" },
  { char: "🖌️", keywords: "brush design paint" },
  { char: "✨", keywords: "sparkles polish magic feature" },
  { char: "⚙️", keywords: "gear settings config engine" },
  { char: "🔧", keywords: "wrench tool fix config" },
  { char: "🔨", keywords: "hammer build tool" },
  { char: "🛠️", keywords: "tools build maintain" },
  { char: "🐙", keywords: "octopus github octocat git" },
  { char: "🌿", keywords: "branch git leaf green" },
  { char: "🌱", keywords: "seedling new grow start" },
  { char: "🌳", keywords: "tree worktree grow" },
  { char: "📡", keywords: "satellite signal api network broadcast" },
  { char: "🛰️", keywords: "satellite space orbit network" },
  { char: "🔭", keywords: "telescope observe research explore" },
  { char: "🔬", keywords: "microscope research inspect detail" },
  { char: "🧩", keywords: "puzzle plugin module piece integration" },
  { char: "📊", keywords: "chart bar stats analytics metrics" },
  { char: "📈", keywords: "chart up growth metrics trend" },
  { char: "📉", keywords: "chart down decline metrics" },
  { char: "💾", keywords: "disk save storage db floppy" },
  { char: "🗄️", keywords: "cabinet storage archive files" },
  { char: "🗃️", keywords: "box files database records" },
  { char: "🧱", keywords: "brick block infra foundation" },
  { char: "🏗️", keywords: "construction build scaffold wip" },
  { char: "🏛️", keywords: "bank classic institution legacy" },
  { char: "🗺️", keywords: "map navigation geo route" },
  { char: "🧭", keywords: "compass navigate direction explore" },
  { char: "📍", keywords: "pin location marker place" },
  { char: "🌐", keywords: "globe web internet world i18n" },
  { char: "🌍", keywords: "earth globe world region" },
  { char: "💬", keywords: "chat message talk comment" },
  { char: "📨", keywords: "mail email message inbox send" },
  { char: "📬", keywords: "mailbox inbox notify" },
  { char: "🔔", keywords: "bell notify alert reminder" },
  { char: "📅", keywords: "calendar schedule date plan" },
  { char: "📝", keywords: "memo note doc write todo" },
  { char: "📋", keywords: "clipboard tasks list copy" },
  { char: "📚", keywords: "books docs library knowledge" },
  { char: "📖", keywords: "book docs read manual" },
  { char: "🏷️", keywords: "label tag name release" },
  { char: "💡", keywords: "idea bulb feature insight" },
  { char: "🔥", keywords: "fire hot flame trending hotfix" },
  { char: "⚡", keywords: "bolt fast power performance energy" },
  { char: "🐛", keywords: "bug defect issue insect" },
  { char: "🩹", keywords: "bandage fix patch hotfix" },
  { char: "🧹", keywords: "broom cleanup chore tidy" },
  { char: "♻️", keywords: "recycle refactor reuse" },
  { char: "🔁", keywords: "loop repeat sync cycle" },
  { char: "🔄", keywords: "sync refresh reload update" },
  { char: "🎯", keywords: "target goal focus aim mvp" },
  { char: "🏁", keywords: "finish flag done release ship" },
  { char: "🚦", keywords: "signal status traffic gate ci" },
  { char: "🚧", keywords: "construction wip barrier blocked" },
  { char: "🔒", keywords: "locked private secure closed" },
  { char: "🔓", keywords: "unlocked open public" },
  { char: "👁️", keywords: "eye watch observe monitor view" },
  { char: "🦾", keywords: "robot arm automation mech" },
  { char: "🐳", keywords: "whale docker container ship" },
  { char: "☁️", keywords: "cloud server hosting infra" },
  { char: "🖥️", keywords: "desktop server computer machine" },
  { char: "📱", keywords: "phone mobile app device" },
  { char: "⌨️", keywords: "keyboard cli terminal input" },
  { char: "🧰", keywords: "toolbox kit utils helpers" },
  { char: "🪝", keywords: "hook webhook git" },
  { char: "🧾", keywords: "receipt log invoice record" },
  { char: "👩‍💻", keywords: "developer coder engineer person" },
  { char: "🎛️", keywords: "control dashboard knobs hud" },
  { char: "🛎️", keywords: "bell service desk support" },
  { char: "🦄", keywords: "unicorn special rare magic" },
  // Languages / runtimes / platforms
  { char: "🐍", keywords: "python snake script" },
  { char: "☕", keywords: "coffee java jvm kotlin scala" },
  { char: "💎", keywords: "gem ruby rails jewel precious" },
  { char: "🦀", keywords: "crab rust systems" },
  { char: "🐹", keywords: "gopher go golang hamster" },
  { char: "🐘", keywords: "elephant php postgres database" },
  { char: "🐧", keywords: "penguin linux os unix" },
  { char: "🍎", keywords: "apple mac ios swift fruit" },
  { char: "🪟", keywords: "window windows os pane" },
  // Status / signals
  { char: "✅", keywords: "check done complete pass success green" },
  { char: "❌", keywords: "cross fail error no red" },
  { char: "⚠️", keywords: "warning caution alert danger" },
  { char: "❗", keywords: "exclamation important alert urgent" },
  { char: "❓", keywords: "question help unknown support" },
  { char: "🟢", keywords: "green online healthy ok status up" },
  { char: "🔴", keywords: "red offline down error status" },
  { char: "🟡", keywords: "yellow degraded warn pending status" },
  { char: "⏳", keywords: "hourglass pending wait queue loading" },
  { char: "⏱️", keywords: "stopwatch timer performance benchmark latency" },
  // Ops / incident / infra
  { char: "🧯", keywords: "extinguisher incident firefight emergency" },
  { char: "🆘", keywords: "sos help emergency alert oncall" },
  { char: "🚨", keywords: "siren alert incident alarm pager" },
  { char: "🔌", keywords: "plug connect integration adapter power" },
  { char: "🔋", keywords: "battery power energy charge capacity" },
  { char: "⚓", keywords: "anchor kubernetes stable base deploy" },
  { char: "🪣", keywords: "bucket s3 storage object container" },
  // Data / files / storage
  { char: "📁", keywords: "folder directory files" },
  { char: "📂", keywords: "folder open directory browse" },
  { char: "🗂️", keywords: "dividers organize folders index" },
  { char: "🧊", keywords: "ice cache cold freeze frozen" },
  { char: "🌊", keywords: "wave stream flow pipeline data" },
  { char: "🔗", keywords: "link url chain reference dependency" },
  { char: "🧲", keywords: "magnet attract fetch pull scrape" },
  // Money / business
  { char: "💰", keywords: "money cost budget billing finance" },
  { char: "💳", keywords: "card payment billing checkout subscription" },
  { char: "🪙", keywords: "coin token crypto currency credits" },
  { char: "🏦", keywords: "bank finance institution account" },
  { char: "🛒", keywords: "cart shop ecommerce store checkout" },
  { char: "🧮", keywords: "abacus compute calculate count math" },
  { char: "⚖️", keywords: "scale balance license legal compare" },
  // People / collaboration
  { char: "👤", keywords: "user person profile account" },
  { char: "👥", keywords: "users team group members" },
  { char: "🤝", keywords: "handshake deal partner merge agreement" },
  { char: "🧙", keywords: "wizard magic setup onboarding automation" },
  { char: "🦉", keywords: "owl wisdom knowledge night insight" },
  // Media / capture
  { char: "🎥", keywords: "video camera record stream capture" },
  { char: "📷", keywords: "camera photo snapshot capture" },
  { char: "📸", keywords: "camera screenshot flash snapshot" },
  { char: "🎬", keywords: "clapper film action start scene" },
  { char: "🎮", keywords: "game controller play gaming demo" },
  // Search / tools / misc
  { char: "🔍", keywords: "search find magnify lookup query" },
  { char: "🔎", keywords: "search find zoom inspect detail" },
  { char: "🪛", keywords: "screwdriver tool fix config tweak" },
  { char: "✂️", keywords: "scissors cut clip trim snippet" },
  { char: "📐", keywords: "ruler measure design geometry layout" },
  { char: "📌", keywords: "pushpin pin mark important sticky" },
  { char: "🔖", keywords: "bookmark save mark tag reference" },
  { char: "💥", keywords: "explosion crash boom break error" },
  { char: "🪐", keywords: "planet space orbit saturn cosmos" },
  { char: "☄️", keywords: "comet fast streak speed space" },
  { char: "🐝", keywords: "bee busy worker swarm queue" },
  { char: "🍀", keywords: "clover luck lucky four fortune" },
  { char: "🦋", keywords: "butterfly transform migrate change" },
  { char: "⭐", keywords: "star favorite featured highlight" },
  { char: "🏆", keywords: "trophy award win achievement milestone" },
  { char: "🎉", keywords: "party celebrate launch release ship" },
];

const _segmenter = new Intl.Segmenter();

/** True when `s` is a single emoji (incl. ZWJ sequences), not ascii/control/overlong. */
export function isSingleEmoji(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  if ([...t].length > 8) return false; // code-point cap, matches server
  const segments = [..._segmenter.segment(t)];
  if (segments.length !== 1) return false; // reject multi-emoji strings
  return /\p{Extended_Pictographic}/u.test(t);
}

/** Relevance score for `e` against query `q` (lowercased) / `raw` (trimmed, original case).
 *  Higher = better: exact char > exact word > word-prefix > mid-substring. 0 = no match. */
function rankEmoji(e: EmojiEntry, q: string, raw: string): number {
  if (e.char === raw) return 1000;
  let best = 0;
  for (const t of e.keywords.split(" ")) {
    if (t === q) best = Math.max(best, 100);
    else if (t.startsWith(q)) best = Math.max(best, 50);
    else if (t.includes(q)) best = Math.max(best, 10);
  }
  // Fallback: query spans a token boundary (e.g. "auth token").
  if (best === 0 && e.keywords.includes(q)) return 5;
  return best;
}

/** Filter the curated set by keyword/char; empty query returns the whole set.
 *  Matches are ranked: exact char, then exact word, word-prefix, then mid-substring. */
export function searchEmoji(query: string): EmojiEntry[] {
  const raw = query.trim();
  const q = raw.toLowerCase();
  if (q === "") return EMOJI;
  return EMOJI.map((e, i) => ({ e, s: rankEmoji(e, q, raw), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.e);
}
