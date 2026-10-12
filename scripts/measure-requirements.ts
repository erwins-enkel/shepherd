#!/usr/bin/env bun
// Live check of reading a task's requirements from its description (issue #2773): every fixture
// from the issue's table through the REAL helper — the production prompt, argv and answer parsing
// (`deriveRequirementsViaAgent`) on a real herdr — with what it derived and how long it took. The
// unit tests stub the helper; this is the evidence that the model reads the fixtures right, and the
// latency the PR documents.
//
// It spawns real agents (billed like any helper run), so it is never part of `bun run test`, and it
// refuses to touch the herdr your live Shepherd uses: start an isolated one first.
//
//   herdr --session measure server            # in another terminal; stop it afterwards
//   HERDR_SESSION=measure bun run scripts/measure-requirements.ts --provider codex --model gpt-5.6-luna
//   HERDR_SESSION=measure bun run scripts/measure-requirements.ts --provider claude --model haiku --trials 3
//
// Flags: --provider claude|codex  --model <id>  --effort <tier>  --trials N  --filter <id-substring>
// Exit code 1 when any fixture was read wrong.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { REQUIREMENTS_FIXTURES } from "./eval-fixtures/requirements";
import { parseHerdrVersion, setDetectedHerdrVersion } from "../src/herdr-capabilities";
import { selectHerdrDriver } from "../src/herdr-socket-driver";
import { deriveRequirementsViaAgent, REQUIREMENTS_LABEL } from "../src/requirements-llm";
import type { AnsweredDerivation } from "../src/requirements-classify-core";
import type { AgentProvider } from "../src/types";

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "claude" },
    model: { type: "string" },
    effort: { type: "string" },
    trials: { type: "string", default: "1" },
    filter: { type: "string" },
  },
});

const session = process.env.HERDR_SESSION?.trim();
if (!session || session === "default") {
  console.error(
    "Refusing to run against the default herdr: start `herdr --session measure server` and set " +
      "HERDR_SESSION=measure, so no helper lands in your live herd.",
  );
  process.exit(2);
}
const provider = values.provider as AgentProvider;
if (provider !== "claude" && provider !== "codex") {
  console.error("--provider must be claude or codex");
  process.exit(2);
}
const trials = Math.max(1, Number(values.trials) || 1);
const fixtures = REQUIREMENTS_FIXTURES.filter(
  (f) => !values.filter || f.id.includes(values.filter),
);

/** What a result reads as, comparable with a fixture's expectation. */
function verdict(result: AnsweredDerivation): string {
  switch (result.status) {
    case "derived":
      return `[${result.requirements.join(", ")}]`;
    case "unclear":
      return "unclear";
    case "failed":
      return `failed:${result.cause}`;
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

// The spawn path depends on the herdr version, as it does at Shepherd's boot.
setDetectedHerdrVersion(parseHerdrVersion(execFileSync("herdr", ["--version"]).toString()));
const herdr = await selectHerdrDriver({ log: () => {} });
const rows: { id: string; expected: string; got: string; ok: boolean; ms: number }[] = [];
let run = 0;
for (const fixture of fixtures) {
  const expected =
    fixture.expect === "unclear" ? "unclear" : `[${[...fixture.expect].sort().join(", ")}]`;
  for (let trial = 0; trial < trials; trial++) {
    const started = performance.now();
    const result = await deriveRequirementsViaAgent(
      fixture,
      { herdr, provider, model: values.model ?? null, effort: values.effort ?? null },
      `${REQUIREMENTS_LABEL}measure-${run++}`,
    );
    const ms = Math.round(performance.now() - started);
    const got = verdict(result);
    rows.push({ id: fixture.id, expected, got, ok: got === expected, ms });
    console.log(
      `${got === expected ? "ok  " : "MISS"} ${fixture.id.padEnd(24)} ${got.padEnd(28)} ${ms} ms`,
    );
  }
}

const times = rows.map((r) => r.ms).sort((a, b) => a - b);
const misses = rows.filter((r) => !r.ok);
console.log("");
console.log(`provider ${provider}, model ${values.model ?? "(default)"}, ${rows.length} runs`);
console.log(`correct  ${rows.length - misses.length}/${rows.length}`);
console.log(
  `latency  p50 ${percentile(times, 0.5)} ms · p90 ${percentile(times, 0.9)} ms · max ${times.at(-1)} ms`,
);
for (const miss of misses)
  console.log(`MISS ${miss.id}: expected ${miss.expected}, got ${miss.got}`);
process.exit(misses.length > 0 ? 1 : 0);
