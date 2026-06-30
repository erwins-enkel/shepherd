#!/bin/sh
# Shepherd — self-contained size-cap rotation for ~/.shepherd/shepherd.log (#1212).
#
# Replaces the former dependency on the external `logrotate` binary. logrotate was OPTIONAL: on a
# host where it was absent (and the best-effort install failed — no root, package unavailable, …)
# the timer was skipped and shepherd.log grew unbounded ("logrotate not found — skipping
# log-rotation timer"). This script reproduces the same posture using only baseline tools (coreutils
# + gzip — gzip is universally present and was already required by logrotate's `compress`), so
# rotation works on every host with systemd:
#   size 50M · keep 7 compressed rotations · copytruncate · missingok · notifempty
#
# copytruncate is REQUIRED, not a preference: shepherd.service redirects stdout/stderr with
# `append:` and holds the fd open O_APPEND for the life of the process. A rename+create rotation
# would leave the server writing to the old (now-unlinked) inode, reclaiming nothing. We instead
# copy the live log aside, compress the copy, then truncate the original IN PLACE — the held fd
# respects the truncation and keeps appending to the same inode. (Tiny race: bytes written between
# the copy and the truncate are lost; the stock logrotate `copytruncate` directive has the
# identical caveat. Acceptable for an app log.)
#
# Run hourly by shepherd-logrotate.timer. Operator-facing deploy plumbing: plain English, not i18n.
set -eu

LOG="${SHEPHERD_LOG:-$HOME/.shepherd/shepherd.log}"
MAX_BYTES="${SHEPHERD_LOG_MAX_BYTES:-52428800}" # 50 MiB
KEEP="${SHEPHERD_LOG_KEEP:-7}"

# missingok + notifempty: nothing to do if the log is absent, and the size gate below covers empty.
[ -f "$LOG" ] || exit 0

# `size 50M`: only rotate once the live log reaches the cap (wc -c is portable; no stat flags).
size=$(wc -c <"$LOG")
[ "$size" -ge "$MAX_BYTES" ] || exit 0

# Age out the oldest rotation, then shift each compressed rotation up by one: .6.gz→.7.gz … .1.gz→.2.gz.
rm -f "$LOG.$KEEP.gz"
i=$((KEEP - 1))
while [ "$i" -ge 1 ]; do
  if [ -f "$LOG.$i.gz" ]; then mv -f "$LOG.$i.gz" "$LOG.$((i + 1)).gz"; fi
  i=$((i - 1))
done

# copytruncate: snapshot the live log to .1, truncate the original in place (preserving the
# server's held O_APPEND fd), then compress the snapshot.
cp "$LOG" "$LOG.1"
: >"$LOG"
gzip -f "$LOG.1"
