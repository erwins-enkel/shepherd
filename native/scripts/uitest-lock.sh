#!/usr/bin/env bash
# Foreground advisory lock; runner-local, held through owned command cleanup.
set -euo pipefail
# -c keeps the command's stdin intact (a Python heredoc would consume it).
exec python3 -c '
import fcntl, os, pathlib, signal, subprocess, sys, time
if len(sys.argv) < 2:
    raise SystemExit("usage: uitest-lock.sh command [args...]")
cancelled = 0
def cancel(signum, frame):
    global cancelled
    cancelled = cancelled or signum
for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, cancel)

def signal_group(pgid, signum):
    try:
        os.killpg(pgid, signum)
        return True
    except ProcessLookupError:
        return False

directory = pathlib.Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "shepherd-uitest"
directory.mkdir(parents=True, exist_ok=True)
with (directory / "lock").open("a") as lock:
    deadline = time.monotonic() + 2700
    while True:
        if cancelled:
            raise SystemExit(128 + cancelled)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise SystemExit("timed out waiting for serialized xcodebuild")
            time.sleep(0.1)
    if cancelled:
        raise SystemExit(128 + cancelled)
    try:
        # A dedicated group contains indirect scripts and their descendants.
        # Inherit the SAME open lock description: if this holder is SIGKILLed,
        # ordinary exec/shell descendants still own it until their final close.
        # Do not explicitly LOCK_UN on exit (that would unlock their copies).
        child = subprocess.Popen(sys.argv[1:], start_new_session=True,
                                 pass_fds=(lock.fileno(),))
    except FileNotFoundError:
        raise SystemExit(127)
    except PermissionError:
        raise SystemExit(126)
    kill_deadline = None
    while True:
        if cancelled and kill_deadline is None:
            signal_group(child.pid, cancelled)
            kill_deadline = time.monotonic() + 5
        if kill_deadline is not None and time.monotonic() >= kill_deadline:
            signal_group(child.pid, signal.SIGKILL)
        result = child.poll()  # Reap our direct child, even if descendants remain.
        if result is not None and not signal_group(child.pid, 0):
            break
        time.sleep(0.05)
    # Never discover/kill processes outside this owned group. Commands must not
    # daemonize/escape the group or close inherited FDs if SIGKILL protection is
    # required; no portable wrapper can enforce that after its own forced death.
    raise SystemExit(128 + cancelled if cancelled else result if result >= 0 else 128 - result)
' "$@"
