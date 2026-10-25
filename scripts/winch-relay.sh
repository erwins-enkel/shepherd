#!/usr/bin/env bash
#
# winch-relay.sh — forwards terminal resizes into a bwrap `--new-session` sandbox.
#
# The membrane passes bwrap `--new-session` (setsid, the CVE-2017-5226 TIOCSTI mitigation), so the
# sandboxed agent has no controlling terminal. A PTY resize SIGWINCHes only the PTY's foreground
# process group — the outer bwrap, which ignores it — and the agent keeps painting at its launch
# width: garbled lines on a narrower client, a blank screen after a rotation.
#
# herdr.ts `buildWrappedArgv` puts this relay in front of every argv carrying `--new-session`, so it
# runs OUTSIDE the sandbox as the pane's foreground job. It runs <argv...> as its child (same process
# group, stdin = the PTY) and on every SIGWINCH re-sends it to each session a descendant started (a
# process whose sid == pid; the relay's own session is led by an ancestor, so it is never one). The
# agent then re-reads the size from its tty fd and repaints. Builtins only: nothing forks per resize
# and nothing polls.
#
# Linux only (/proc). Without CONFIG_PROC_CHILDREN the walk finds nothing — exactly the behaviour
# without the relay.
#
# Invocation contract:
#   winch-relay.sh -- <argv...>
# Exits with <argv...>'s status.

set -u
shopt -s nullglob

[ "${1:-}" = "--" ] || {
  echo "winch-relay: usage: winch-relay.sh -- <argv...>" >&2
  exit 2
}
shift
[ $# -gt 0 ] || {
  echo "winch-relay: missing argv after '--'" >&2
  exit 2
}

# `<&0` is load-bearing: a non-interactive bash points a background job's stdin at /dev/null.
"$@" <&0 &
CHILD=$!

relay() {
  local queue=("$CHILD") pid line f
  local -a fields kids
  while [ ${#queue[@]} -gt 0 ]; do
    pid=${queue[0]}
    queue=("${queue[@]:1}")
    # A descendant can exit mid-walk; its vanished /proc entry is no error worth printing.
    { read -r line < "/proc/$pid/stat"; } 2>/dev/null || continue
    # After "(comm) ": state ppid pgrp session …
    read -r -a fields <<< "${line##*) }"
    if [ "${fields[3]}" = "$pid" ]; then
      # The session's leader: its process group is what the kernel would have signalled.
      kill -WINCH -- "-$pid" 2>/dev/null
      continue
    fi
    for f in "/proc/$pid/task/"*/children; do
      kids=()
      { read -r -a kids < "$f"; } 2>/dev/null
      queue+=("${kids[@]}")
    done
  done
}
trap relay WINCH

# A trapped SIGWINCH interrupts `wait` while the child still runs, so wait again until it is gone;
# bash keeps an exited background child's status, so the last `wait` reads it either way.
while kill -0 "$CHILD" 2>/dev/null; do
  wait "$CHILD"
done
wait "$CHILD"
exit $?
