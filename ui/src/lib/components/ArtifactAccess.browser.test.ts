import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";

const getSessionArtifact = vi.fn();
const enableSessionArtifact = vi.fn();
vi.mock("#lib/api.js", async (orig) => ({
  ...(await orig<typeof import("#lib/api.js")>()),
  getSessionArtifact: (...a: unknown[]) => getSessionArtifact(...a),
  enableSessionArtifact: (...a: unknown[]) => enableSessionArtifact(...a),
}));

const { ApiError } = await import("#lib/api.js");
const { default: ArtifactAccess } = await import("./ArtifactAccess.svelte");
const { invokesDesign } = await import("#lib/artifact-access.js");

afterEach(() => {
  document.body.innerHTML = "";
  getSessionArtifact.mockReset();
  enableSessionArtifact.mockReset();
});

const enableButton = () => page.getByRole("button", { name: "Enable Artifact for this session" });

describe("ArtifactAccess (#4293)", () => {
  it("renders nothing when the session keeps Artifact", async () => {
    getSessionArtifact.mockResolvedValue({ trimmed: false });
    render(ArtifactAccess, { sessionId: "s1" });
    await expect.poll(() => getSessionArtifact.mock.calls.length).toBe(1);
    expect(getSessionArtifact).toHaveBeenCalledWith("s1");
    expect(document.querySelector("[data-testid=artifact-access]")).toBeNull();
  });

  it("explains a trimmed Artifact tool and enables it for the session", async () => {
    getSessionArtifact.mockResolvedValue({ trimmed: true });
    enableSessionArtifact.mockResolvedValue({ session: { id: "s1" }, restarted: true });
    render(ArtifactAccess, { sessionId: "s1" });
    const row = page.getByTestId("artifact-access");
    await expect.element(row).toMatchTextContent(m.artifact_access_title());
    await expect.element(row).toMatchTextContent(m.artifact_access_hint());
    await expect.element(page.getByRole("button", { name: "Why Artifact is off" })).toBeVisible();

    await userEvent.click(enableButton());
    expect(enableSessionArtifact).toHaveBeenCalledWith("s1");
    await expect.element(page.getByRole("status")).toHaveTextContent(m.artifact_access_restarted());
    expect(document.querySelector("[data-testid=artifact-access]")).toBeNull();
  });

  it("a refused restart keeps the opt-in for the next resume", async () => {
    getSessionArtifact.mockResolvedValue({ trimmed: true });
    enableSessionArtifact.mockRejectedValue(
      new ApiError(409, "resume-refused", "resume-refused", true),
    );
    render(ArtifactAccess, { sessionId: "s1" });
    await userEvent.click(enableButton());
    await expect.element(page.getByRole("status")).toHaveTextContent(m.artifact_access_saved());
  });

  it("any other failure keeps the action for a retry", async () => {
    getSessionArtifact.mockResolvedValue({ trimmed: true });
    enableSessionArtifact.mockRejectedValue(new ApiError(500, "boom"));
    render(ArtifactAccess, { sessionId: "s1" });
    await userEvent.click(enableButton());
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.artifact_access_failed());
    await expect.element(enableButton()).toBeEnabled();
  });
});

describe("invokesDesign", () => {
  it("matches a /design token, not prose or other commands", () => {
    expect(invokesDesign("/design a pricing page")).toBe(true);
    expect(invokesDesign("use this reference\n/design")).toBe(true);
    expect(invokesDesign("see docs/design/hero.png")).toBe(false);
    expect(invokesDesign("/designer")).toBe(false);
    expect(invokesDesign("/design-system")).toBe(false);
  });
});
