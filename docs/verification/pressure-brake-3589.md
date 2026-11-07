# Pressure-brake calibration (#3589)

Calibrates the heavy-check pressure brake defaults in `src/heavy-slot-core.ts` →
`defaultHeavySlotBudget()` against measured load. Result:

| Limit                   | Before (provisional)   | Calibrated                           |
| ----------------------- | ---------------------- | ------------------------------------ |
| Available-RAM floor     | `min(4 GiB, 15 % RAM)` | `min(7.5 GiB, 15 % RAM)` (15 % kept) |
| PSI memory `full avg10` | 20 %                   | 20 % (confirmed)                     |
| Release hold            | 30 s                   | 30 s (confirmed)                     |

Settings → Resources no longer labels these limits provisional.

## Setup

- **Host:** GitHub-hosted `ubuntu-latest` runner, isolated per job, never the shared operator
  machine — the run drives memory into pressure on purpose. 4 vCPUs, 15.61 GiB RAM, 3 GiB swap,
  kernel 7.0.0-1019-azure (identical for every rep).
- **Harness:** `scripts/pressure-calibration/run.ts`, run by
  `.github/workflows/pressure-calibration.yml` (dispatch-only, or a push to `calibration/**`).
  Analysis: `scripts/pressure-calibration/analyze.ts`; pure core with unit tests:
  `scripts/pressure-calibration/core.ts`, `test/pressure-calibration-core.test.ts`.
- **Workloads**, each in its own git worktree per lane: `cargo check` (CLI), root
  `bun run typecheck`, UI `svelte-check`, UI `vite build`, and the affected browser tests
  (`heavy-slot`, `SettingsResourcesPanel`).
- **Phases:** baseline (each workload once, solo) → worker sweep (`cargo -j W`, browser
  `--maxWorkers=W`, W ∈ {1, 2, 4, 8, 16}) → settle → ramp (one looping lane every 60 s up to the
  peak, held 180 s, then one stopped every 60 s) → cooldown.
- **Sampled at 1 Hz:** `MemAvailable`, swap, PSI memory some/full avg10/avg60, PSI cpu/io,
  `oom_kill` count, process-tree RSS of all load, and the latency of an HTTP probe (Bun server +
  separate client, every 100 ms) standing in for Shepherd's single event loop.
- **Safety:** load processes run at `oom_score_adj` 500, harness and runner agent at −900; no new
  lane starts below 5 % available RAM or above PSI full 50. This governor gates lanes only, never
  the jobs a running lane restarts, and it refused no lane in any scored rep.

## Decision rule

- **Unhealthy:** probe p95 > 250 ms over a 10 s window while PSI memory some avg10 ≥ 10, or an OOM
  kill. Episodes closer than 30 s merge.
- **Replay:** each trace is resampled to the service's 5 s tick and folded through the real
  `nextBrake()` for every candidate in floor {5, 7.5, 10, 12.5, 15, 20, 25} % RAM × PSI
  {5, 10, 15, 20, 30, 40} × hold {15, 30, 60, 90} s.
- **Job starts:** each lane loops its workloads, and the brake gates every job start. A start the
  brake would hold back is _harmful_ if that job ran into an unhealthy episode, _harmless_ if it
  ended before one (or no episode came).
- **Score, safety first:** covered (engaged at an episode's onset tick) ↓, harmful starts held ↓,
  flaps (re-engaged within 60 s of a release) ↑, harmless starts held ↑, then closest to the
  previous values. The previous values are kept if they match the best coverage and hold back at
  most one harmful start fewer.
- **Revision:** the first rule counted only lane starts before the first episode as harmless. That
  scored the lanes that brought the host to the cliff as harmless, and 5 % then won. The PR review
  caught it; the rule above replaced it and the operator kept 15 %.
- **Cap:** the largest single-job peak at W = 16 (16-core / 32 GiB reference host). ≤ 4 GiB keeps
  4 GiB; above that, the next 0.5 GiB step above the peak.

## Results

| Rep    | Run         | Peak lanes      | Min avail | Max PSI full10 | Max PSI some10 | Probe max | Episodes | Outcome                              |
| ------ | ----------- | --------------- | --------- | -------------- | -------------- | --------- | -------- | ------------------------------------ |
| l8-r1  | 42395354903 | 8               | 1.55 GiB  | 2.3            | 5.9            | 22 ms     | 0        | completed                            |
| l8-r2  | 42395354903 | 8               | 2.27 GiB  | 1.9            | 3.0            | 48 ms     | 0        | completed                            |
| l12-r1 | 42398283695 | 12              | 1.43 GiB  | 5.4            | 15.4           | 52 ms     | 0        | completed                            |
| —      | 42398283695 | 10 (11 skipped) | –         | –              | –              | –         | –        | runner lost, data lost               |
| l12-r2 | 42404628914 | 12              | 0.18 GiB  | 27.7           | 39.9           | 1208 ms   | 1        | runner lost, data recovered from log |
| l12-r3 | 42404628914 | 12              | 0.83 GiB  | 14.7           | 30.8           | 368 ms    | 0        | completed                            |

No OOM kill was recorded. At 12 lanes the TypeScript and UI workloads slowed 3–12× against their
solo runs; cargo's ramp medians are not comparable (see Limitations). The event-loop probe stayed
fast until available RAM fell under ~1 GiB with swap exhausted. The one unhealthy episode (l12-r2,
during the ramp-down with 10 lanes still running, 0.21 GiB available, PSI full 16 at onset)
preceded the runner losing contact with GitHub; a second 12-lane rep died the same way after the safety governor
had refused lane 11, but before its data was uploaded (the harness now mirrors every sample to the
job log, which is how l12-r2 survived).

**Brake replay** (with the 7.5 GiB cap):

Ten jobs ran into the episode.

- 15 % / 20 / 30 s (kept): covers it, engaging 63 s before onset, and holds back 9 of the 10. The
  cost under heavy but healthy load: 41 harmless starts held, 2 flaps across all reps.
- 5 % / 20 / 30 s: also covers it (58 s ahead) but holds back only 6 of the 10.
- Only 90 s holds catch all 10, at the price of more harmless starts held (20–106) — within the
  keep-current margin.

The floor, PSI 20 and the 30 s hold are confirmed.

**Cap:** browser tests at `--maxWorkers=16` peaked at 7.24 GiB (cargo `-j 16`: 2.87 GiB; fit
0.33 GiB per browser worker) → 7.5 GiB, so one heavy job's peak fits under the floor. With the 15 %
floor this changes hosts between 26.7 and 50 GiB (a 32 GiB host now brakes at 4.8 GiB instead of
4 GiB) and caps at 7.5 GiB above 50 GiB.

Full tables (baseline, sweep, per-lane ramp, slowdown, top candidates):
[`pressure-brake-3589/summary.md`](pressure-brake-3589/summary.md). Raw samples and events:
`pressure-brake-3589/raw/<rep>/{samples,events}.ndjson.gz`.

## Regression

`test/heavy-slot-brake-traces.test.ts` replays each measured trace in
`test/fixtures/heavy-slot-brake-traces/` through `defaultHeavySlotBudget()`: the brake must engage
at every unhealthy episode, hold back at least as many harmful job starts as at calibration, no more
harmless ones, flap no more, release only after the hold, and be off once the load is gone. A 5 %
floor fails it (6 of 9 harmful starts held on l12-r2).

## Limitations

- One episode on one host size (4 vCPU / 16 GiB).
- Held-back starts are counted on the measured trace; in reality a held job waits and changes the
  load that follows.
- cargo is under-represented: after its first round a lane only touches `cli/src/main.rs`, so later
  `cargo check` runs are incremental (ramp medians of 2 s in l8-r1 and l12-r3).
- Linux only: macOS has no PSI, and its memory signal is not calibrated here.
- The probe is a stand-in for Shepherd's event loop, not Shepherd itself.
- The cap is taken from forced worker counts on 4 vCPUs, not from a 16-core host.

## Rerun

Dispatch **Pressure-brake calibration** (inputs: peak lanes, step and hold seconds) or push to a
`calibration/**` branch. The `analysis` artifact holds `summary.md`, `selection.json` and new
fixtures. If a runner dies, rebuild its rep from the job log:

```sh
gh run view --job <job-id> --log > rep.log
grep -o '\[cal:sample\] .*' rep.log | cut -d' ' -f2- | tr -d '\r' > rep/samples.ndjson
grep -o '\[cal:event\] .*' rep.log | cut -d' ' -f2- | tr -d '\r' > rep/events.ndjson
bun scripts/pressure-calibration/analyze.ts --out analysis <rep-dir>...
```

Never run `run.ts` on the shared operator machine.
