# Pressure-brake calibration (#3589)

Calibrates the heavy-check pressure brake defaults in `src/heavy-slot-core.ts` →
`defaultHeavySlotBudget()` against measured load. Result:

| Limit                   | Before (provisional)   | Calibrated              |
| ----------------------- | ---------------------- | ----------------------- |
| Available-RAM floor     | `min(4 GiB, 15 % RAM)` | `min(7.5 GiB, 5 % RAM)` |
| PSI memory `full avg10` | 20 %                   | 20 % (confirmed)        |
| Release hold            | 30 s                   | 30 s (confirmed)        |

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
  lane starts below 5 % available RAM or above PSI full 50.

## Decision rule (fixed before measuring)

- **Unhealthy:** probe p95 > 250 ms over a 10 s window while PSI memory some avg10 ≥ 10, or an OOM
  kill. Episodes closer than 30 s merge.
- **Replay:** each trace is resampled to the service's 5 s tick and folded through the real
  `nextBrake()` for every candidate in floor {5, 7.5, 10, 12.5, 15, 20, 25} % RAM × PSI
  {5, 10, 15, 20, 30, 40} × hold {15, 30, 60, 90} s.
- **Score:** covered (engaged at an episode's onset tick) ↓, flaps (re-engaged within 60 s of a
  release) ↑, harmless starts blocked (lane starts held back before the first episode) ↑, then
  closest to the previous values. The previous values are kept if they match the best coverage and
  flaps and block at most one start more.
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

No OOM kill was recorded. At 12 lanes every workload slowed 3–12× against its solo run, but the
event-loop probe stayed fast until available RAM fell under ~1 GiB with swap exhausted. The one
unhealthy episode (l12-r2, 12 lanes started, 0.21 GiB available, PSI full 16 at onset) preceded the
runner losing contact with GitHub; a second 12-lane rep died the same way after the safety governor
had refused lane 11, but before its data was uploaded (the harness now mirrors every sample to the
job log, which is how l12-r2 survived).

**Brake replay** (with the 7.5 GiB cap):

- 5 % / 20 / 30 s: covers the episode, engaging 58 s before onset; 0 flaps, 0 harmless starts
  blocked.
- 15 % / 20 / 30 s (previous): also covers it (63 s ahead), but sits at the edge of normal
  12-lane load — 2 flaps and 2 harmless starts blocked across l12-r2 and l12-r3.

PSI 20 and the 30 s hold were confirmed; the floor drops to 5 %.

**Cap:** browser tests at `--maxWorkers=16` peaked at 7.24 GiB (cargo `-j 16`: 2.87 GiB; fit
0.33 GiB per browser worker) → 7.5 GiB. On hosts under 150 GiB the 5 % floor applies, not the cap.

Full tables (baseline, sweep, per-lane ramp, slowdown, top candidates):
[`pressure-brake-3589/summary.md`](pressure-brake-3589/summary.md). Raw samples and events:
`pressure-brake-3589/raw/<rep>/{samples,events}.ndjson.gz`.

## Regression

`test/heavy-slot-brake-traces.test.ts` replays each measured trace in
`test/fixtures/heavy-slot-brake-traces/` through `defaultHeavySlotBudget()`: the brake must engage
at every unhealthy episode, block no more harmless starts than at calibration, never flap, release
only after the hold, and be off once the load is gone. The previous 15 % floor fails the flap check.

## Limitations

- One episode on one host size (4 vCPU / 16 GiB); 5 % is the lowest floor in the grid, so the data
  cannot tell whether an even lower floor would also hold.
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
