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
    order.push(dependent);
    if (m[2]) edges.push(...parseFenceEdges(dependent, m[2]));
  }
  return { members: [...order], order, edges };
}

export function parseEpicBody(body: string): ParsedEpic {
  const fence = body.match(FENCE_RE);
  if (fence) return parseFencedEpic(fence[1] ?? "");
  const members: number[] = [];
  for (const m of body.matchAll(CHECK_RE)) members.push(Number(m[1]));
  return { members, order: [...members], edges: [] };
}
