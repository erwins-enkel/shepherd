#!/usr/bin/env python3
"""Read-only app-relaunch preflight. Quit leaves the local server running.

Sessions and herdr continue without interruption. No database or agent probe is
needed: only explicit Stop/Restart changes the server lifecycle.
Exit codes: 0 safe to relaunch, 1 internal error.
"""
from __future__ import annotations

import os
import subprocess
import sys

PORT = int(os.environ.get("SHEPHERD_PORT", "7330"))


def run(*argv: str) -> str:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def pids(pattern: str) -> list[int]:
    return [int(p) for p in run("pgrep", "-f", pattern).split()]


def listener(port: int) -> int | None:
    out = run("lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN").split()
    return int(out[0]) if out else None


def main() -> int:
    apps = pids("Shepherd.app/Contents/MacOS/Shepherd")
    server = listener(PORT)
    if not apps:
        print("No Shepherd app is running; nothing to interrupt.")
    elif server:
        print(f"Quitting the app leaves the server on :{PORT} (pid {server}) running; sessions continue.")
    else:
        print(f"No server on :{PORT}; safe to relaunch the app.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"preflight failed: {error}", file=sys.stderr)
        sys.exit(1)
