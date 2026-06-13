#!/usr/bin/env bash
#
# egress-runner.sh — process orchestrator for the per-agent network-namespace
# egress firewall (issue #551).
#
# herdr.start() spawns this as the TOP process in a PTY; herdr.stop() kills it.
# The runner sets up a per-agent rootless netns whose only egress is to IPs
# dnsmasq pins for allowlisted hosts, then execs the agent's already-composed
# inner argv (normally `bwrap <membrane+egress-override flags> -- claude …`)
# INSIDE that netns.
#
# Invocation contract:
#   egress-runner.sh --tmp <tmpDir> -- <inner argv...>
#
# <tmpDir> (created+owned by the caller, NOT this script) contains:
#   egress.nft     — nftables ruleset (loaded with `nft -f`).
#   dnsmasq.argv   — dnsmasq arguments, one per line (read into a bash array).
#
# <inner argv...> is execed verbatim inside the netns. Its stdio (fds 0/1/2 =
# the inherited PTY) MUST pass through unchanged — do NOT redirect it.
#
# SIGKILL-robustness (the crux): the netns owner is PID 1 of a fresh pid+net+user
# ns under pdeathsig SIGKILL. If this runner dies — even by SIGKILL, where no trap
# fires — the kernel SIGKILLs that PID 1 (pdeathsig), and PID-1 death auto-reaps
# the WHOLE pidns (dnsmasq, bwrap, claude). The slirp4netns uplink is ALSO
# pdeathsig-bound because it runs host-side, outside bwrap's --die-with-parent,
# so that leash is its only reliable link to the runner. The EXIT trap is
# belt-and-suspenders for the graceful path only.

set -uo pipefail

die() {
  echo "egress-runner: $*" >&2
  exit 1
}

# ── parse args: --tmp <dir> -- <inner argv...> ────────────────────────────────
TMP=""
INNER=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tmp)
      [ $# -ge 2 ] || die "--tmp requires an argument"
      TMP="$2"
      shift 2
      ;;
    --)
      shift
      INNER=("$@")
      break
      ;;
    *)
      die "unexpected argument '$1' (expected --tmp <dir> -- <inner argv...>)"
      ;;
  esac
done

[ -n "$TMP" ] || die "missing --tmp <dir>"
[ ${#INNER[@]} -gt 0 ] || die "missing inner argv after '--'"
[ -d "$TMP" ] || die "tmp dir does not exist: $TMP"
[ -r "$TMP/egress.nft" ] || die "missing or unreadable: $TMP/egress.nft"
[ -r "$TMP/dnsmasq.argv" ] || die "missing or unreadable: $TMP/dnsmasq.argv"

# ── required host tools ───────────────────────────────────────────────────────
for tool in setpriv unshare slirp4netns nft dnsmasq; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found on PATH: $tool"
done

# ── graceful-path cleanup (belt-and-suspenders; pdeathsig is the real leash) ──
cleanup() { [ -n "${SLIRP:-}" ] && kill "$SLIRP" 2>/dev/null; }
trap cleanup EXIT INT TERM

# ── (A) netns owner = PID 1 of a fresh pid+net+user ns under pdeathsig ─────────
# Inside the ns: bring lo up, wait for slirp's tap0 to appear, load nft, start
# dnsmasq, then exec the inner argv (inheriting the PTY fds).
setpriv --pdeathsig SIGKILL \
  unshare --user --map-root-user --net --pid --fork --mount-proc --kill-child --forward-signals \
  bash -c '
    set -uo pipefail
    ip link set lo up 2>/dev/null || true
    for i in $(seq 1 200); do ip link show tap0 >/dev/null 2>&1 && break; sleep 0.05; done
    # Fail-closed: the agent must NEVER reach exec unless the firewall loaded.
    ip link show tap0 >/dev/null 2>&1 || {
      echo "egress-runner: tap0 never appeared; refusing to exec agent" >&2
      exit 1
    }
    nft -f "$1" || {
      echo "egress-runner: nft load failed; refusing to exec agent" >&2
      exit 1
    }
    mapfile -t DARGS < "$2"
    dnsmasq "${DARGS[@]}" >/dev/null 2>&1 &
    DNSMASQ_PID=$!
    sleep 0.2
    kill -0 "$DNSMASQ_PID" 2>/dev/null || {
      echo "egress-runner: dnsmasq failed to start; refusing to exec agent" >&2
      exit 1
    }
    shift 2
    exec "$@"
  ' bash "$TMP/egress.nft" "$TMP/dnsmasq.argv" "${INNER[@]}" &
CHILD=$!

# Race gate: slirp4netns setns()es into the child's user+net namespace, which fails
# with EPERM until `unshare --map-root-user` has committed the uid_map. An unmapped
# userns reads /proc/<pid>/uid_map as EMPTY; a mapped one has a row — so poll for a
# non-empty uid_map before launching slirp (deterministic, no fixed sleep).
for _ in $(seq 1 200); do
  [ -s "/proc/$CHILD/uid_map" ] && grep -q '[0-9]' "/proc/$CHILD/uid_map" 2>/dev/null && break
  # If the child already died, bail rather than spin the full timeout.
  kill -0 "$CHILD" 2>/dev/null || break
  sleep 0.01
done

# ── (B) slirp4netns uplink, ALSO pdeathsig-bound (host-side leash) ────────────
setpriv --pdeathsig SIGKILL \
  slirp4netns --configure --mtu=65520 --disable-host-loopback "$CHILD" tap0 &
SLIRP=$!

wait "$CHILD"   # agent runs; stdio = inherited PTY fds (never redirected)
exit $?         # propagate the agent's exit code to herdr
