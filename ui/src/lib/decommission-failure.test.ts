import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/api";
import { m } from "$lib/paraglide/messages";
import { describeDecommissionFailure } from "./decommission-failure";

const reasonOf = (r: ReturnType<typeof describeDecommissionFailure>) => r.detail.reason;
const section = (r: ReturnType<typeof describeDecommissionFailure>, label: string) =>
  r.detail.sections.find((s) => s.label === label);

describe("describeDecommissionFailure", () => {
  it("names an unreachable server when the request got no response", () => {
    const r = describeDecommissionFailure(new TypeError("Failed to fetch"), "archive");
    expect(reasonOf(r)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_network_reason() }),
    );
    expect(section(r, m.decommission_fail_next())?.text).toBe(m.decommission_fail_network_next());
    expect(section(r, m.decommission_fail_server())).toBeUndefined();
    expect(r.retryable).toBe(true);
  });

  it("refuses to retry a merge whose PR closed without merging, and says why", () => {
    const err = new ApiError(409, "no open PR to merge", "pr_already_closed", true);
    const r = describeDecommissionFailure(err, "merge");
    expect(reasonOf(r)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_pr_closed_reason() }),
    );
    expect(section(r, m.decommission_fail_what())?.text).toBe(m.decommission_fail_pr_closed_what());
    expect(section(r, m.decommission_fail_next())?.text).toBe(m.decommission_fail_pr_closed_next());
    expect(r.retryable).toBe(false);
  });

  it("refuses to retry a merge whose branch has no PR left", () => {
    const err = new ApiError(409, "no open PR to merge", "pr_not_found", true);
    const r = describeDecommissionFailure(err, "merge");
    expect(reasonOf(r)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_pr_missing_reason() }),
    );
    expect(r.retryable).toBe(false);
  });

  it("recognizes a GitHub rate limit in the server message", () => {
    const err = new ApiError(
      502,
      "Command failed: gh pr merge 5 --repo o/r --squash\nGraphQL: API rate limit already exceeded for user ID 1.",
      undefined,
      true,
    );
    const r = describeDecommissionFailure(err, "merge");
    expect(reasonOf(r)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_rate_limit_reason() }),
    );
    expect(section(r, m.decommission_fail_next())?.text).toBe(
      m.decommission_fail_rate_limit_next(),
    );
    expect(r.retryable).toBe(true);
  });

  it("falls back to the failed step, carrying the server's own message verbatim", () => {
    const err = new ApiError(
      409,
      "merge conflict — resolve manually before merging",
      undefined,
      true,
    );
    const r = describeDecommissionFailure(err, "merge");
    expect(reasonOf(r)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_merge_reason() }),
    );
    expect(section(r, m.decommission_fail_next())?.text).toBe(m.decommission_fail_merge_next());
    expect(section(r, m.decommission_fail_server())).toEqual({
      label: m.decommission_fail_server(),
      text: "merge conflict — resolve manually before merging",
      mono: true,
    });
    expect(r.retryable).toBe(true);

    const close = describeDecommissionFailure(new ApiError(502, "boom", undefined, true), "close");
    expect(reasonOf(close)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_close_reason() }),
    );
    expect(section(close, m.decommission_fail_next())?.text).toBe(m.decommission_fail_retry_next());
  });

  it("explains a teardown failure and omits a server message the server never wrote", () => {
    const err = new ApiError(500, "archive failed: 500", undefined, false);
    const r = describeDecommissionFailure(err, "archive");
    expect(reasonOf(r)).toBe(
      m.decommission_fail_reason({ reason: m.decommission_fail_archive_reason() }),
    );
    expect(section(r, m.decommission_fail_what())?.text).toBe(m.decommission_fail_archive_what());
    expect(section(r, m.decommission_fail_server())).toBeUndefined();
    expect(r.retryable).toBe(true);
  });

  it("treats a not-open code on the close or archive step as an ordinary failure", () => {
    // Only a MERGE step dead-ends on a gone PR; the commit already advances a close past it.
    const err = new ApiError(409, "no open PR", "pr_already_closed", true);
    expect(describeDecommissionFailure(err, "close").retryable).toBe(true);
  });
});
