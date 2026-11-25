import { afterEach, expect, it, vi } from "vitest";
import { sendReviewFeedback } from "./api";

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

it("returns null when delivered", async () => {
  reply(200, { sent: true });
  expect(await sendReviewFeedback("s1", ["ic:1"])).toBeNull();
});

it("returns the server's refusal reason on a 409 (#4144)", async () => {
  reply(409, { sent: false, reason: "pr_closed" });
  expect(await sendReviewFeedback("s1")).toBe("pr_closed");
});

it("reads an unknown or missing reason as failed", async () => {
  reply(409, { sent: false, reason: "from_the_future" });
  expect(await sendReviewFeedback("s1")).toBe("failed");
  reply(409, { sent: false });
  expect(await sendReviewFeedback("s1")).toBe("failed");
});
