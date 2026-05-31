import { describe, it, expect, vi } from "vitest";
import { imageFilesFromItems, handleImagePaste } from "./clipboard";

/** Minimal DataTransferItem stub. */
function item(kind: string, type: string, file: File | null): DataTransferItem {
  return { kind, type, getAsFile: () => file } as unknown as DataTransferItem;
}

function list(items: DataTransferItem[]): DataTransferItemList {
  const l = { length: items.length } as unknown as Record<number, DataTransferItem> & {
    length: number;
  };
  items.forEach((it, i) => (l[i] = it));
  return l as unknown as DataTransferItemList;
}

const png = new File(["x"], "shot.png", { type: "image/png" });

describe("imageFilesFromItems", () => {
  it("returns image files (Cmd+V of a screenshot)", () => {
    const out = imageFilesFromItems(list([item("file", "image/png", png)]));
    expect(out).toEqual([png]);
  });

  it("ignores plain-text items (so text paste falls through to xterm)", () => {
    const out = imageFilesFromItems(list([item("string", "text/plain", null)]));
    expect(out).toEqual([]);
  });

  it("picks only the image out of a mixed clipboard", () => {
    const out = imageFilesFromItems(
      list([item("string", "text/plain", null), item("file", "image/png", png)]),
    );
    expect(out).toEqual([png]);
  });

  it("skips image items whose getAsFile yields null", () => {
    expect(imageFilesFromItems(list([item("file", "image/png", null)]))).toEqual([]);
  });

  it("handles null/empty clipboard", () => {
    expect(imageFilesFromItems(null)).toEqual([]);
    expect(imageFilesFromItems(list([]))).toEqual([]);
  });
});

/** Minimal ClipboardEvent stub carrying the given items. */
function pasteEvent(items: DataTransferItem[]): ClipboardEvent {
  return {
    clipboardData: { items: list(items) },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

describe("handleImagePaste", () => {
  it("uploads the screenshot and swallows the paste", () => {
    const e = pasteEvent([item("file", "image/png", png)]);
    const onImages = vi.fn();
    expect(handleImagePaste(e, onImages)).toBe(true);
    expect(onImages).toHaveBeenCalledWith([png]);
    expect(e.preventDefault).toHaveBeenCalledOnce();
  });

  it("lets a plain-text paste fall through untouched", () => {
    const e = pasteEvent([item("string", "text/plain", null)]);
    const onImages = vi.fn();
    expect(handleImagePaste(e, onImages)).toBe(false);
    expect(onImages).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
