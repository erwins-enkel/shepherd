#!/usr/bin/env python3
"""Says what quitting the running Shepherd.app would do to live work, before mac-dev.sh does it.

Quitting the app stops the local server it supervises (its whole process group).
Agents live in herdr panes, so they survive as long as herdr is not in that group
and is not a child of the app; the next server boot re-matches them. If herdr dies
too, that boot marks every session "done".

Read-only: /api/health (no auth), the server's SQLite file opened read-only,
`herdr agent list`, ps/lsof. Never signals anything.

Exit codes: 0 safe to quit, 2 live sessions would be interrupted (needs --yes),
3 live sessions would be lost (needs --force), 1 internal error.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import urllib.request

PORT = int(os.environ.get("SHEPHERD_PORT", "7330"))
ACTIVE = ("running", "idle", "blocked")


def run(*argv: str) -> str:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def proc(pid: int) -> tuple[int, int] | None:
    """(ppid, pgid) of a live pid."""
    fields = run("ps", "-o", "ppid=,pgid=", "-p", str(pid)).split()
    return (int(fields[0]), int(fields[1])) if len(fields) == 2 else None


def pids(pattern: str) -> list[int]:
    return [int(p) for p in run("pgrep", "-f", pattern).split()]


def listener(port: int) -> int | None:
    out = run("lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN").split()
    return int(out[0]) if out else None


def database_path() -> str:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=3) as response:
            local = json.load(response).get("localInstall") or {}
            if local.get("databasePath"):
                return local["databasePath"]
    except (OSError, ValueError):
        pass
    return os.environ.get("SHEPHERD_DB", os.path.expanduser("~/.shepherd/shepherd.db"))


def active_sessions(db: str) -> list[tuple[str, str, str, str]]:
    connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
    try:
        marks = ",".join("?" * len(ACTIVE))
        return connection.execute(
            f"select desig, status, name, herdrAgentId from sessions where status in ({marks}) order by desig",
            ACTIVE,
        ).fetchall()
    finally:
        connection.close()


def herdr_terminals() -> set[str] | None:
    """Live herdr terminal ids, or None when herdr does not answer."""
    out = run("herdr", "agent", "list")
    try:
        result = json.loads(out).get("result", {})
    except ValueError:
        return None
    return {agent.get("terminal_id") for agent in result.get("agents", [])}


def main() -> int:
    apps = pids("Shepherd.app/Contents/MacOS/Shepherd")
    server = listener(PORT)
    if not apps:
        print("No Shepherd app is running; nothing to interrupt.")
        return 0
    server_proc = proc(server) if server else None
    if not server or not server_proc or server_proc[0] not in apps:
        print(f"No app-supervised server on :{PORT}; quitting the app interrupts no sessions.")
        return 0

    db = database_path()
    try:
        sessions = active_sessions(db)
    except sqlite3.Error as error:
        print(f"Could not read sessions from {db} ({error}); treating the restart as interrupting.")
        sessions = [("?", "unknown", "sessions unreadable", "")]
    if not sessions:
        print(f"The supervised server (pid {server}) has no active sessions; safe to restart.")
        return 0

    terminals = herdr_terminals()
    herdr_pids = pids("herdr server")
    doomed = [
        pid for pid in herdr_pids
        if (info := proc(pid)) and (info[1] == server_proc[1] or info[0] in apps or info[0] == server)
    ]

    print(f"Quitting the app stops the local server (pid {server}) that hosts these sessions:")
    for desig, status, name, terminal in sessions:
        alive = terminals is not None and terminal in terminals
        print(f"  {desig:<9} {status:<8} {name}  [agent {'alive in herdr' if alive else 'NOT found in herdr'}]")

    if terminals is None or doomed:
        why = (
            f"herdr (pid {', '.join(map(str, doomed))}) would die with the app or server"
            if doomed else "herdr does not answer, so the agents cannot be confirmed"
        )
        print(f"\nRISK OF LOSS: {why}. The next server boot would mark these sessions done.")
        print("Rerun with --force only if losing them is acceptable.")
        return 3

    print("\nherdr runs independently, so the agents keep working, but until you press Start in the")
    print("new app the server is down: agents cannot report to it, in-flight critic reviews end, and")
    print("the UI shows nothing live. On Start the server re-attaches the sessions above.")
    print("Rerun with --yes to accept this interruption.")
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # a preflight that crashes must not look like "safe"
        print(f"preflight failed: {error}", file=sys.stderr)
        sys.exit(1)
