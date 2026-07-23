import { describe, expect, it } from "vitest";
import { attachmentPastePayload } from "./attachment-paste";

describe("attachmentPastePayload", () => {
  it("keeps image payloads byte-identical to the bare path", () => {
    expect(attachmentPastePayload("/wt/.shepherd-uploads/a.png", "image/png")).toBe(
      "/wt/.shepherd-uploads/a.png",
    );
    expect(attachmentPastePayload("/wt/.shepherd-uploads/b.jpg", "image/jpeg")).toBe(
      "/wt/.shepherd-uploads/b.jpg",
    );
  });

  it("appends the ffmpeg hint for video MIMEs", () => {
    for (const mime of ["video/mp4", "video/quicktime", "VIDEO/MP4"]) {
      expect(attachmentPastePayload("/wt/.shepherd-uploads/rec.mp4", mime)).toBe(
        "/wt/.shepherd-uploads/rec.mp4 (screen-recording video — extract keyframes/audio with ffmpeg to view)",
      );
    }
  });
});
