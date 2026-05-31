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

/** Filter the curated set by keyword/char; empty query returns the whole set. */
export function searchEmoji(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return EMOJI;
  return EMOJI.filter((e) => e.keywords.includes(q) || e.char === query.trim());
}
