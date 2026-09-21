#!/usr/bin/env bash
# Foreground advisory lock; runner-local, released by the OS on exit.
set -euo pipefail
# -c keeps the command's stdin intact (a Python heredoc would consume it).
exec python3 -c '
import fcntl, os, pathlib, subprocess, sys, time
if len(sys.argv) < 2:
    raise SystemExit("usage: uitest-lock.sh command [args...]")
directory = pathlib.Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "shepherd-uitest"
directory.mkdir(parents=True, exist_ok=True)
with (directory / "lock").open("a") as lock:
    deadline = time.monotonic() + 2700
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise SystemExit("timed out waiting for serialized xcodebuild")
            time.sleep(1)
    try:
        result = subprocess.run(sys.argv[1:], check=False)
    except FileNotFoundError:
        raise SystemExit(127)
    except PermissionError:
        raise SystemExit(126)
    raise SystemExit(result.returncode if result.returncode >= 0 else 128 - result.returncode)
' "$@"
