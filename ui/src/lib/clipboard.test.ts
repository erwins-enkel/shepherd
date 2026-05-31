import { describe, it, expect } from "vitest";
import { imageFilesFromItems } from "./clipboard";

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
