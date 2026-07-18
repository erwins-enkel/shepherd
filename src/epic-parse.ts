export interface EpicEdge {
  dependent: number;
  blocker: number;
}
export interface ParsedEpic {
  members: number[];
  order: number[];
  edges: EpicEdge[];
}

const FENCE_RE = /```epic-dag\s*\n([\s\S]*?)```/;
const LINE_RE = /^#(\d+)\s*(?:<-\s*(.+))?$/;
const CHECK_RE = /^\s*-\s*\[[ xX]\]\s*#(\d+)\b/gm;

function parseFenceEdges(dependent: number, depStr: string): EpicEdge[] {
  const result: EpicEdge[] = [];
  for (const tok of depStr.split(",")) {
    const b = tok.trim().match(/#(\d+)/);
    if (b) result.push({ dependent, blocker: Number(b[1]) });
  }
  return result;
}

function parseFencedEpic(fenceBody: string): ParsedEpic {
  const order: number[] = [];
  const edges: EpicEdge[] = [];
  for (const raw of fenceBody.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const dependent = Number(m[1]);
    // A member is a set: a node listed on multiple lines (e.g. `#9 <- #7` then `#9 <- #8`
    // to express two blockers) counts once, keeping its first-seen position — later lines
    // still contribute their edges below. A duplicate member would otherwise flow into a
    // duplicate epic child and break EpicPanel's keyed {#each} (each_key_duplicate).
    if (!order.includes(dependent)) order.push(dependent);
    if (m[2]) edges.push(...parseFenceEdges(dependent, m[2]));
  }
  return { members: [...order], order, edges };
}

export function parseEpicBody(body: string): ParsedEpic {
  const fence = body.match(FENCE_RE);
  if (fence) return parseFencedEpic(fence[1] ?? "");
  const members: number[] = [];
  // Dedupe (first-seen wins) for the same set-of-members reason as the fenced path.
  for (const m of body.matchAll(CHECK_RE)) {
    const n = Number(m[1]);
    if (!members.includes(n)) members.push(n);
  }
  return { members, order: [...members], edges: [] };
}
