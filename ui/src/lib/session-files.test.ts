import { describe, it, expect } from "vitest";
import { computeHasFiles } from "./session-files";
import type { Session, LaunchAttachmentMetadata, SessionLaunchMetadata } from "./types";

// Minimal Session builder — computeHasFiles only reads status, claudeSessionId, launchMetadata.
function session(over: {
  status?: Session["status"];
  claudeSessionId?: string;
  attachments?: LaunchAttachmentMetadata[];
}): Session {
  const launchMetadata =
    over.attachments === undefined
      ? null
      : ({ attachments: over.attachments } as unknown as SessionLaunchMetadata);
  return {
    status: over.status ?? "running",
    claudeSessionId: over.claudeSessionId ?? "",
    launchMetadata,
  } as unknown as Session;
}

const att = (over: Partial<LaunchAttachmentMetadata> = {}): LaunchAttachmentMetadata => ({
  submittedName: "shot.png",
  launchedName: "shot.png",
  dropped: false,
  ...over,
});

describe("computeHasFiles", () => {
  it("is true for a live Claude session (has a scratchpad), no attachments", () => {
    expect(computeHasFiles(session({ claudeSessionId: "sess-1" }))).toBe(true);
  });

  it("is true for a non-Claude session with a non-dropped attachment", () => {
    expect(computeHasFiles(session({ claudeSessionId: "", attachments: [att()] }))).toBe(true);
  });

  it("is false for a non-Claude session with no attachments", () => {
    expect(computeHasFiles(session({ claudeSessionId: "" }))).toBe(false);
  });

  it("is false when every attachment was dropped (swept)", () => {
    expect(
      computeHasFiles(session({ claudeSessionId: "", attachments: [att({ dropped: true })] })),
    ).toBe(false);
  });

  it("is false for an archived session even with attachments", () => {
    expect(
      computeHasFiles(
        session({ status: "archived", claudeSessionId: "sess-1", attachments: [att()] }),
      ),
    ).toBe(false);
  });
});
