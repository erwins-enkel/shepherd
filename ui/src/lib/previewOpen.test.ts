import { describe, expect, test, vi } from "vitest";
import { openPreviewInNewTab } from "./previewOpen";

describe("openPreviewInNewTab", () => {
  test("builds the preview URL and opens it with noopener,noreferrer", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("window", { open });
    const loc = {
      protocol: "https:",
      hostname: "hud.example.test",
    } as Location;

    const url = openPreviewInNewTab("agent.tail.test", loc, 8123);

    expect(url).toBe("https://agent.tail.test:8123/");
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });
});
