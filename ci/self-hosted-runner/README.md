# Shepherd self-hosted CI runner

A locally-hosted GitHub Actions runner for `erwins-enkel/shepherd`, so CI for this
**private** repo stops burning the account's included Actions minutes. The workflows
(`.github/workflows/ci.yml`, `pr-hygiene.yml`) target it via
`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` — set the repo Actions variable
`CI_RUNNER=self-hosted` to route jobs here, delete it to fall straight back to
GitHub-hosted runners.

## What & why — the cost trade-off

GitHub-hosted minutes for a private repo cost roughly **$0.008/min** (Linux, 2-core).
Buying minutes is the **zero-risk fallback**: no host to secure, no untrusted code on
our hardware. The _safer_ self-host target is a **separate / throwaway host** that
runs nothing else of value. This runner instead runs **beside production Shepherd on
the same box** — a deliberate decision to avoid standing up a second machine. That
co-tenancy is the entire reason the security model below is strict: untrusted PR code
executes a few namespaces away from prod. If that ever feels like too much risk, the
exit is one command (`gh variable delete CI_RUNNER`) and you're back on hosted minutes.

## Security model

This runner executes **untrusted PR code** (anything a contributor pushes to a branch),
one fresh container per job. The posture:

- **Ephemeral, one job per container.** `EPHEMERAL=true` + `docker run --rm`: the
  runner deregisters and the container is destroyed after a single job. The systemd
  unit restarts to register a fresh container + fresh token for the next job. No state
  survives a job.
- **No shared writable cache.** Playwright's browsers are **baked read-only into the
  image** (`Dockerfile`), so every job gets its own copy-on-write copy of a known-good
  cache — no cross-job cache-poisoning volume.
- **Network isolation — CONDITIONED on prod binding loopback.** The container runs on
  the default `bridge` network (never `--network host`). Production Shepherd defaults
  to `host = 127.0.0.1` (`src/config.ts:38`), and a bridge container **cannot** reach
  host loopback services. **FOOTGUN:** a `0.0.0.0`-bound service IS reachable from the
  container via the `docker0` gateway IP. So `SHEPHERD_HOST=0.0.0.0` (the
  `src/config.ts:38` escape hatch) **defeats this isolation** — and the **herdr server's
  bind must be loopback too**, for the same reason. Keep both on loopback. (See the
  optional defense-in-depth firewall rule under Prerequisites for bind-independent
  isolation.)
- **Unprivileged, no socket.** No `--privileged`, no docker-socket mount, no
  `--pid host`. Untrusted code can't reach the daemon or other containers.
- **Host-minted token; PAT never enters the container.** `mint-token.sh` mints a
  short-lived **registration token** on the host (via host `gh` login or an optional
  host-only `pat.env`). Only that token crosses into the container as `RUNNER_TOKEN`;
  the admin PAT never does. **Residual:** the registration token is a container env
  var, so job steps can read it until it expires. Accepted — it's not the admin PAT,
  it's ~1h TTL, and the runner is ephemeral.
- **Root-in-container → prefer rootless Docker.** The myoung34 base runs the container
  **as root**, and the in-job `playwright install --with-deps` uses passwordless sudo
  (so we can't add `--security-opt no-new-privileges`). Under **rootful** Docker
  (the daemon as installed on this box today) container-root is a real escalation
  surface. Under **rootless** Docker, container-root maps to an unprivileged _host_
  uid — a much smaller blast radius. **Rootless Docker is recommended on this shared
  host.**

## Prerequisites

### 1. Docker — rootless recommended

Rootless Docker maps container-root to your unprivileged host user, shrinking the blast
radius of untrusted root-in-container code (see Security model). Install/enable it per
the [rootless docs](https://docs.docker.com/engine/security/rootless/).

**Make the rootless socket resolvable under systemd user units.** The units set
`XDG_RUNTIME_DIR=%t` but do **not** set `DOCKER_HOST`, so the `docker` CLI must already
default to the rootless socket — otherwise it talks to the rootful `/var/run/docker.sock`
(or fails), silently defeating the rootless recommendation. Persist one of:

- `docker context use rootless` — writes `~/.docker`, which the units read because they
  set `HOME=%h`. Recommended (one-time, nothing per-unit). Confirm with `docker context show`.
- or a systemd drop-in (`systemctl --user edit shepherd-ci-runner@.service`) with

  ```ini
  [Service]
  Environment=DOCKER_HOST=unix://%t/docker.sock
  ```

  `%t` is expanded by systemd to your runtime dir. **Do not** put
  `DOCKER_HOST=unix://${XDG_RUNTIME_DIR}/docker.sock` in `.env` — `EnvironmentFile` passes
  values literally and never expands variables, so `docker` would receive a literal
  `${XDG_RUNTIME_DIR}`. A concrete literal path in `.env` works
  (`DOCKER_HOST=unix:///run/user/<your-uid>/docker.sock`).

**Verify the resource caps actually enforce.** `--cpus`/`--memory` are no-ops unless the
kernel cgroup controllers are delegated. Confirm a memory cap really lands:

```sh
docker run --rm --memory=64m alpine cat /sys/fs/cgroup/memory.max
```

This must print `67108864` (64 MiB). If it prints `max`, the cap is **not** enforced —
delegate the cgroup controllers (rootless: enable `cpu`/`memory` delegation for your
user, e.g. via a `systemd` drop-in on `user@.service`) before trusting the slice /
`--memory` limits.

### 2. Linger, so user units run at boot

User systemd units only run while you're logged in unless linger is enabled:

```sh
loginctl enable-linger "$USER"
```

### 3. Assert prod binds loopback

The network isolation above only holds if nothing this runner could reach is bound to
`0.0.0.0`. Before enabling the runner, confirm:

- **Shepherd:** `SHEPHERD_HOST` is **unset or `127.0.0.1`** (never `0.0.0.0`).
- **herdr server:** likewise bound to loopback.

Optional **defense in depth** (makes isolation bind-independent): a firewall rule that
**drops traffic from the docker bridge subnet to the `docker0` gateway IP**, so even a
`0.0.0.0`-bound service can't be reached from a container. Example (adjust subnet/IP to
your `docker0`):

```sh
# Drop bridge-subnet -> docker0-gateway (host) traffic.
sudo iptables -I DOCKER-USER -s 172.17.0.0/16 -d 172.17.0.1 -j DROP
```

## Setup

Run these in order. **Do not set `CI_RUNNER` until a runner is live** — see the last
step's warning.

1. **Build the image** (the `IMAGE` tag in `.env`):

   ```sh
   docker build -t shepherd-ci-runner:local ci/self-hosted-runner/
   ```

2. **Create the host-only config** and fill in `RUNNER_DIR` (the absolute path to _this_
   checkout's `ci/self-hosted-runner` directory):

   ```sh
   mkdir -p ~/.config/shepherd-ci-runner
   cp ci/self-hosted-runner/.env.example ~/.config/shepherd-ci-runner/.env
   $EDITOR ~/.config/shepherd-ci-runner/.env   # set RUNNER_DIR
   ```

   If the host has **no** `gh` login, also create the optional, host-only PAT file
   (fine-grained PAT, repo Administration: Read & Write), **chmod 600**, never committed:

   ```sh
   printf 'GH_TOKEN=<fine-grained-PAT>\n' > ~/.config/shepherd-ci-runner/pat.env
   chmod 600 ~/.config/shepherd-ci-runner/pat.env
   ```

3. **Install the units** into the user systemd dir (symlink to keep them tracking the
   checkout, or copy):

   ```sh
   mkdir -p ~/.config/systemd/user
   ln -sf "$PWD"/ci/self-hosted-runner/shepherd-ci-runner@.service          ~/.config/systemd/user/
   ln -sf "$PWD"/ci/self-hosted-runner/shepherd-ci.slice                    ~/.config/systemd/user/
   ln -sf "$PWD"/ci/self-hosted-runner/shepherd-ci-runner-watchdog.service  ~/.config/systemd/user/
   ln -sf "$PWD"/ci/self-hosted-runner/shepherd-ci-runner-watchdog.timer    ~/.config/systemd/user/
   systemctl --user daemon-reload
   ```

4. **Start the runner replica(s).** One replica handles jobs serially; add `@2` so the
   `verify` and `pr-hygiene` jobs can run in parallel:

   ```sh
   systemctl --user enable --now shepherd-ci-runner@1   # runner-1
   systemctl --user enable --now shepherd-ci-runner@2   # runner-2 (parallel verify + hygiene)
   ```

5. **Start the watchdog timer:**

   ```sh
   systemctl --user enable --now shepherd-ci-runner-watchdog.timer
   ```

6. **Verify the runner is live** in the repo UI: **Settings → Actions → Runners** should
   show the runner(s) as **Idle**.

7. **Only then** route CI to it:

   ```sh
   gh variable set CI_RUNNER --body self-hosted
   ```

   > ⚠️ Setting `CI_RUNNER` **before** a runner is live and Idle would make every PR job
   > queue against a label nothing serves — all PR CI hangs pending. Confirm **Idle**
   > first.

## ⚠️ MANDATORY public-repo cutover

> **Before making this repo public, run `gh variable delete CI_RUNNER`.**
>
> A self-hosted runner attached to a **public** repo executes **fork-PR code on this
> host** — any internet stranger's pull request runs on your machine, beside production.
> This is GitHub's own loud warning, and here it's non-negotiable. Delete the variable
> (reverting CI to GitHub-hosted runners) **before** the repo goes public, and tear the
> runner down if it won't be re-privatized.

## Egress real-machinery tests

**`test/egress-runner.test.ts` exercises the REAL rootless-netns machinery** —
`slirp4netns`/`nft`/`dnsmasq`/`unshare`/`setpriv` — and tears it down with SIGKILL.
It must **NEVER** run on this host: the rootless docker daemon that serves the
runner containers uses its **OWN shared `slirp4netns`**, and churning the real
machinery here can take it out, knocking every runner offline (2026-06-12 incident;
issue #591). The suite **self-skips** via `test/egress-runner-gate.ts`
(`egressRunnerShouldSkip`, unit-tested in `test/egress-runner-gate.test.ts`), which
skips when the host can't do rootless user+net namespaces, when running under `CI`,
**or** when a rootless docker socket is present — so it runs only on a capable local
host without rootless docker, never in any CI job. **Do NOT weaken that gate** (e.g.
don't reintroduce a hosted/self-hosted-only condition): the fail-closed `CI` +
rootless-socket checks are precisely what keep it off this box.

## Outage runbook

**Symptom:** PR checks are stuck **pending** (queued, spinner, never go red). Because
`CI_RUNNER` is set, the workflows no longer fall back to GitHub-hosted runners — GitHub
just waits indefinitely for a matching self-hosted runner that isn't there. A pending
check is invisible (no red X), so nothing pages you on its own. The **watchdog timer**
is the thing that alerts you (journal + desktop toast).

**Immediate fix — restore CI instantly:**

```sh
gh variable delete CI_RUNNER
```

This reverts every workflow to `ubuntu-latest` on the next run; re-run the stuck jobs and
they go to GitHub-hosted runners. **Then** repair the runner at leisure and, once it shows
**Idle** again, re-set the variable:

```sh
systemctl --user status 'shepherd-ci-runner@*' shepherd-ci-runner-watchdog.service
journalctl --user -u shepherd-ci-runner-watchdog.service -n 50
# ...fix the underlying issue (image, docker, gh auth, network)...
gh variable set CI_RUNNER --body self-hosted
```

To inspect what the watchdog saw:

```sh
systemctl --user list-timers shepherd-ci-runner-watchdog.timer
journalctl --user -u shepherd-ci-runner-watchdog.service -f
```

## Operations

### Replicas

`@1` alone runs jobs serially. Add `@2` so `ci.yml`'s `verify` and `pr-hygiene.yml` can
run concurrently. More replicas raise the host load ceiling — keep an eye on the slice.

### Resource tuning

- Per-replica caps live in `~/.config/shepherd-ci-runner/.env`: `RUNNER_CPUS` (default
  `4`) and `RUNNER_MEMORY` (default `8g`) become the container's `--cpus`/`--memory`
  (the _suspenders_).
- The host-wide ceiling is `shepherd-ci.slice` (`CPUQuota=600%`, `MemoryMax=16G`) — a
  _belt_ meant to cap **all** replicas combined. `run-runner.sh` binds containers to it
  with `--cgroup-parent=shepherd-ci.slice`, but that only takes effect under **rootless**
  Docker (daemon in the user systemd tree). Under **rootful** Docker the containers land
  in the system tree, so this user slice does **not** enforce — install the slice as a
  system unit (`/etc/systemd/system`) for the belt there, or rely on the per-container
  `--cpus`/`--memory` caps. It further requires the docker daemon to use the **systemd
  cgroup driver** (`native.cgroupdriver=systemd`, the default here; check
  `docker info | grep "Cgroup Driver"`) — under the `cgroupfs` driver the `.slice` name is
  a literal cgroup path, not this systemd unit, so the belt won't engage even rootless.
  Tune both together: per-replica caps × replicas should sit at or under the slice. (CPU is
  capped below the aggregate; `MemoryMax` only equals it — lower it for real prod memory
  headroom, per the comment in `shepherd-ci.slice`.)

### Playwright version-sync

The image bakes a specific Playwright build (`1.60.0` at time of writing). If
`ui/package.json` bumps Playwright, **rebuild the image** so the warm cache matches:

```sh
docker build -t shepherd-ci-runner:local ci/self-hosted-runner/
```

It **self-heals at runtime if it drifts** — the in-job `playwright install` re-downloads
the matching build into the ephemeral container, so drift costs a one-time download per
job, never a failure. Rebuilding just restores the fast no-op.

### Disk housekeeping

Ephemeral `--rm` containers don't accumulate, but image layers and dangling build cache
do over time:

```sh
docker system prune          # dangling images + build cache
docker image prune -a        # also unused tagged images (heavier)
```

### Teardown

```sh
# 1. Revert CI to GitHub-hosted FIRST, so removing the runner doesn't strand pending jobs.
gh variable delete CI_RUNNER

# 2. Stop + disable the units.
systemctl --user disable --now shepherd-ci-runner@1 shepherd-ci-runner@2
systemctl --user disable --now shepherd-ci-runner-watchdog.timer

# 3. Remove any lingering runner registrations from the repo
#    (Settings → Actions → Runners, or via gh api repos/erwins-enkel/shepherd/actions/runners).

# 4. Reclaim disk.
docker image rm shepherd-ci-runner:local
docker system prune -a --volumes
```
