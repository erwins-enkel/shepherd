import { describe, it, expect, vi } from "vitest";
import { portal } from "./portal";

// The node project has no DOM, so stub the slice of the Element API the action
// touches: appendChild (records the new parent), parentNode (set by appendChild),
// and removeChild (clears it). Mirrors the stub-everything style of clipboard.test.ts.
function stubNode(): HTMLElement {
  const node = {
    parentNode: null as unknown as ParentNode | null,
    appendChild(child: { parentNode: ParentNode | null }) {
      child.parentNode = node as unknown as ParentNode;
      return child;
    },
    removeChild(child: { parentNode: ParentNode | null }) {
      child.parentNode = null;
      return child;
    },
  };
  return node as unknown as HTMLElement;
}

describe("portal action", () => {
  it("appends the node to a provided target on apply", () => {
    const target = stubNode();
    const node = stubNode();
    const append = vi.spyOn(target, "appendChild");

    portal(node, target);

    expect(append).toHaveBeenCalledWith(node);
    expect(node.parentNode).toBe(target);
  });

  it("removes the node from its parent on destroy", () => {
    const target = stubNode();
    const node = stubNode();

    const { destroy } = portal(node, target);
    expect(node.parentNode).toBe(target);

    destroy();
    expect(node.parentNode).toBeNull();
  });

  it("destroy is a harmless no-op when the node was already detached", () => {
    const target = stubNode();
    const node = stubNode();

    const { destroy } = portal(node, target);
    // simulate Svelte already detaching it during teardown (parentNode is read-only)
    (node as { parentNode: ParentNode | null }).parentNode = null;

    expect(() => destroy()).not.toThrow();
  });
});
