import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, LockHeldError } from "../../ci/onboarding-harness/lock";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "shep-onb-lock-")), "onboarding-harness.lock");
}

/** A lock left behind by a run that is provably gone. */
const dead = () => false;
/** A lock still held by a live harness run. */
const live = () => true;

describe("acquireHostLock", () => {
  it("takes a free lock and records the owner, so a later run can judge staleness", () => {
    const path = lockPath();
    const { release } = acquireHostLock("run-1", { path, isLive: dead });
    const owner = JSON.parse(readFileSync(path, "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.runId).toBe("run-1");
    expect(Date.parse(owner.startedAt)).not.toBeNaN();
    release();
  });

  it("releases the lock, and a second release is a no-op", () => {
    const path = lockPath();
    const { release } = acquireHostLock("run-1", { path, isLive: dead });
    release();
    expect(existsSync(path)).toBe(false);
    expect(() => release()).not.toThrow();
  });

  it("refuses a lock whose owner is still alive", () => {
    const path = lockPath();
    acquireHostLock("run-1", { path, isLive: live });
    expect(() => acquireHostLock("run-2", { path, isLive: live })).toThrow(LockHeldError);
  });

  it("reclaims a lock whose owner died — a killed run must not disable the harness", () => {
    const path = lockPath();
    acquireHostLock("run-1", { path, isLive: live });
    const { release } = acquireHostLock("run-2", { path, isLive: dead });
    expect(JSON.parse(readFileSync(path, "utf8")).runId).toBe("run-2");
    release();
  });

  // The Aug 2026 outage: a 0-byte lock from the pre-owner format blocked every
  // nightly for 21 days, because "file exists" was the whole staleness test.
  it("reclaims an empty legacy lock that records no owner at all", () => {
    const path = lockPath();
    writeFileSync(path, "");
    const { release } = acquireHostLock("run-2", { path, isLive: live });
    expect(JSON.parse(readFileSync(path, "utf8")).runId).toBe("run-2");
    release();
  });

  it("reclaims a lock whose contents are unparseable", () => {
    const path = lockPath();
    writeFileSync(path, "not json{");
    const { release } = acquireHostLock("run-2", { path, isLive: live });
    expect(JSON.parse(readFileSync(path, "utf8")).runId).toBe("run-2");
    release();
  });

  it("reclaims when the recorded pid was recycled by an unrelated process", () => {
    const path = lockPath();
    acquireHostLock("run-1", { path, isLive: live });
    // isLive answers false for a live-but-foreign pid: liveness alone is not
    // ownership, or a recycled pid would lock the harness out indefinitely.
    const { release } = acquireHostLock("run-2", { path, isLive: dead });
    expect(JSON.parse(readFileSync(path, "utf8")).runId).toBe("run-2");
    release();
  });

  it("reports the blocking owner so the operator can see who holds it", () => {
    const path = lockPath();
    acquireHostLock("run-1", { path, isLive: live });
    try {
      acquireHostLock("run-2", { path, isLive: live });
      throw new Error("expected LockHeldError");
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      expect((err as LockHeldError).message).toContain(String(process.pid));
    }
  });
});

describe("acquireHostLock reclaim reporting", () => {
  it("reports a clean acquire as not reclaimed", () => {
    const path = lockPath();
    const { release, reclaimed } = acquireHostLock("run-1", { path, isLive: dead });
    expect(reclaimed).toBe(false);
    release();
  });

  // The caller uses this to sweep the instances the dead run leaked — nothing else
  // ever will, since its own teardown never ran.
  it("flags a reclaim so the caller can clear the dead run's orphans", () => {
    const path = lockPath();
    acquireHostLock("run-1", { path, isLive: live });
    const { release, reclaimed } = acquireHostLock("run-2", { path, isLive: dead });
    expect(reclaimed).toBe(true);
    release();
  });
});
