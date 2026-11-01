// security-watch triage: verdict gate, retries, and the operator's file-now actions.
import { test, expect } from "bun:test";
import { agentError, cs, dep, REPO, world } from "./security-watch-fixture";

const NO = {
  fixable: false,
  confidence: "high",
  hypothesis: "h",
  files: [],
  reason: "false positive",
};

test("only fixable + high is filed", async () => {
  for (const verdict of [NO, { ...NO, fixable: true, confidence: "medium" }]) {
    const { w, poller, triage } = world();
    w.verdict = verdict;
    w.setCs([cs(1)]);
    await poller.poll();
    expect(w.created).toHaveLength(0);
    expect(triage.rejected().map((g) => g.triage?.reason)).toEqual(["false positive"]);
  }
});

test("the prompt is plugin-authored; alert text only arrives as untrusted sections", async () => {
  const { w, poller } = world();
  w.setCs([cs(1)]);
  w.setDep([dep(2)]);
  await poller.poll();
  for (const t of w.triaged) {
    expect(t.prompt).not.toContain("MESSAGE");
    expect(t.prompt).not.toContain("ADVISORY");
  }
  expect(w.triaged.map((t) => t.content).join()).toContain("MESSAGE-1");
  expect(w.triaged.map((t) => t.content).join()).toContain("ADVISORY-2");
});

test("a rejected set is not triaged again; a new alert in the group is", async () => {
  const { w, poller } = world();
  w.verdict = NO;
  w.setCs([cs(1)]);
  await poller.poll();
  await poller.poll();
  expect(w.triaged).toHaveLength(1);
  expect(w.status().triaged).toBe(1);
  w.setCs([cs(1), cs(2)]);
  await poller.poll();
  expect(w.triaged).toHaveLength(2);
});

test("cap-exceeded defers with backoff and keeps the group out of re-triage", async () => {
  const { w, poller, triage } = world();
  w.verdict = agentError("cap-exceeded");
  w.setCs([cs(1)]);
  await poller.poll();
  expect(w.status().deferred).toBe(1);
  expect(w.group().triage?.outcome).toBe("pending");
  await poller.poll();
  expect(w.status()["triage-pending"]).toBe(1);
  expect(w.triaged).toHaveLength(1);
  await triage.advance();
  expect(w.triaged).toHaveLength(1);
  w.clock += 16 * 60_000;
  await triage.advance();
  expect(w.triaged).toHaveLength(2);
  expect(w.group().triage?.retries).toBe(2);
  w.verdict = { fixable: true, confidence: "high", hypothesis: "h", files: [], reason: "r" };
  w.clock += 31 * 60_000;
  await triage.advance();
  expect(w.created).toHaveLength(1);
});

test("other agent errors reject with the code", async () => {
  const { w, poller } = world();
  w.verdict = agentError("no-output");
  w.setCs([cs(1)]);
  await poller.poll();
  expect(w.group().triage).toMatchObject({
    outcome: "rejected",
    reason: "triage failed: no-output",
  });
});

test("File anyway files a rejection, marks it, bypasses the cap and still counts", async () => {
  const { w, poller, triage } = world();
  w.verdict = NO;
  w.setCs([cs(1)]);
  await poller.poll();
  w.state.set("meta:daily", {
    day: new Date(w.clock).toISOString().slice(0, 10),
    counts: { [REPO]: 3 },
  });
  const res = await triage.fileAnyway(w.group().key);
  expect(res).toMatchObject({ ok: true, filing: { status: "filed" } });
  expect(w.created[0]?.body).toContain("operator override");
  expect(w.state.get<{ counts: Record<string, number> }>("meta:daily")?.counts[REPO]).toBe(4);
  expect(triage.rejected()).toHaveLength(0);
});

test("File anyway refusals", async () => {
  const { w, poller, triage } = world();
  expect(await triage.fileAnyway("map:nope")).toEqual({ ok: false, code: "unknown" });
  w.setCs([cs(1)]);
  await poller.poll();
  expect(await triage.fileAnyway(w.group().key)).toEqual({ ok: false, code: "not-rejected" });
});

test("opt-in gate refuses File anyway and File again, leaving the group untouched", async () => {
  const { w, poller, triage } = world();
  w.verdict = NO;
  w.setCs([cs(1)]);
  await poller.poll();
  w.visibility = "public";
  const before = w.group();
  expect(await triage.fileAnyway(before.key)).toEqual({
    ok: true,
    filing: { status: "needs-ack" },
  });
  expect(w.created).toHaveLength(0);
  expect(w.group()).toEqual(before);

  const again = world();
  again.w.setCs([cs(1)]);
  await again.poller.poll();
  again.w.closeIssue(41);
  await again.poller.poll();
  again.w.visibility = "unknown";
  expect(await again.triage.fileAgain(again.w.group().key)).toEqual({
    ok: true,
    filing: { status: "needs-ack" },
  });
  expect(again.w.created).toHaveLength(1);
});

test("File again re-files a closed group; only closed groups qualify", async () => {
  const { w, poller, triage } = world();
  w.setCs([cs(1)]);
  await poller.poll();
  const key = w.group().key;
  expect(await triage.fileAgain(key)).toEqual({ ok: false, code: "not-closed" });
  w.closeIssue(41);
  await poller.poll();
  expect(triage.closedStillOpen().map((g) => g.key)).toEqual([key]);
  expect(await triage.fileAgain(key)).toMatchObject({ ok: true, filing: { status: "filed" } });
  expect(w.group().filing).toMatchObject({ number: 42, attempts: 2, sync: "open" });
  expect(triage.closedStillOpen()).toHaveLength(0);
});

test("retries stop when the repo is unwatched or loses the opt-in", async () => {
  const { w, poller, triage } = world();
  w.verdict = agentError("cap-exceeded");
  w.setCs([cs(1)]);
  await poller.poll();
  w.clock += 16 * 60_000;
  w.setConfig({ enabled: false });
  await triage.advance();
  expect(w.triaged).toHaveLength(1);
  w.setConfig({ enabled: true });
  w.state.set("visibility:/r/web", "public");
  await triage.advance();
  expect(w.triaged).toHaveLength(1);
});
