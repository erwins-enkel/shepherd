import { findDesigLinks } from "./desigLinks";

/** Link known designations in sanitized Markdown, preserving code and existing links. */
export function linkifySessionDesignations(root: HTMLElement, live: ReadonlyMap<string, string>) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("code, pre, a")) nodes.push(node);
  }
  for (const node of nodes) {
    const text = node.data;
    const links = findDesigLinks(text, live);
    if (links.length === 0) continue;
    const fragment = doc.createDocumentFragment();
    let start = 0;
    for (const link of links) {
      fragment.append(text.slice(start, link.start));
      const a = doc.createElement("a");
      a.href = `#session-${encodeURIComponent(link.id)}`;
      a.dataset.sessionId = link.id;
      a.textContent = text.slice(link.start, link.end);
      fragment.append(a);
      start = link.end;
    }
    fragment.append(text.slice(start));
    node.replaceWith(fragment);
  }
}
