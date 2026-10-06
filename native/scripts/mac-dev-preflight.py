#!/usr/bin/env python3
"""Says what quitting the running Shepherd.app would do to live work, before mac-dev.sh does it.

Older apps stop the supervised server (its whole process group) on quit. A
matching live ownership record positively identifies a detaching build; only
that running app can skip these risk checks.
Agents live in herdr panes, so they survive as long as herdr is not in that group
and is not a child of the app; the next server boot re-matches them. If herdr dies
too, that boot marks every session "done".

Read-only: /api/health (no auth), the server's SQLite file opened read-only,
`herdr agent list`, ps/lsof. Never signals anything.

Exit codes: 0 safe to quit, 2 live sessions would be interrupted (needs --yes),
3 live sessions would be lost (needs --force), 1 internal error.
"""
from __future__ import annotations

import ctypes
import json
import os
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

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


class ProcBSDInfo(ctypes.Structure):
    """Darwin sys/proc_info.h's proc_bsdinfo (the same ABI Swift uses)."""
    _fields_ = [
        (name, ctypes.c_uint32) for name in (
            "pbi_flags", "pbi_status", "pbi_xstatus", "pbi_pid", "pbi_ppid",
            "pbi_uid", "pbi_gid", "pbi_ruid", "pbi_rgid", "pbi_svuid",
            "pbi_svgid", "rfu_1",
        )
    ] + [
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
    ] + [
        (name, ctypes.c_uint32) for name in (
            "pbi_nfiles", "pbi_pgid", "pbi_pjobc", "e_tdev", "e_tpgid",
        )
    ] + [
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def process_start(pid: int) -> dict[str, int] | None:
    """Exact kernel birth time, matching KernelProcessIdentity.read in Swift."""
    if sys.platform != "darwin" or pid <= 1:
        return None
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        probe = libproc.proc_pidinfo
        probe.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                          ctypes.c_void_p, ctypes.c_int]
        probe.restype = ctypes.c_int
        info = ProcBSDInfo()
        size = ctypes.sizeof(info)
        # PROC_PIDTBSDINFO = 3; SZOMB = 5. Short reads must never grant ownership.
        if probe(pid, 3, 0, ctypes.byref(info), size) != size or info.pbi_status == 5:
            return None
        return {"seconds": info.pbi_start_tvsec, "microseconds": info.pbi_start_tvusec}
    except (OSError, AttributeError, ctypes.ArgumentError):
        return None


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


def detaches_on_quit(server: int, apps: list[int]) -> bool:
    """Only a running detaching build writes ownership. Ignore unrelated records.

    Require the listener to remain a child of a running app: an old app next to
    a detached server must never inherit that server's capability claim.
    """
    info = proc(server)
    if not info or info[0] not in apps:
        return False
    directory = Path.home() / ".shepherd/run"
    for path in [directory / "app-server.json", *directory.glob("app-server-*.json")]:
        try:
            record = json.loads(path.read_text())
            pid = record["pid"]
            owner = proc(pid)
            if (record["port"] == PORT and owner and owner[0] in apps
                    and record["processGroup"] == owner[1]
                    and (start := process_start(pid)) is not None
                    and record["processStart"] == start
                    and (pid == server or owner[1] == info[1])):
                return True
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return False


def main() -> int:
    apps = pids("Shepherd.app/Contents/MacOS/Shepherd")
    server = listener(PORT)
    if not apps:
        print("No Shepherd app is running; nothing to interrupt.")
        return 0
    if server and detaches_on_quit(server, apps):
        print(f"Quitting the app leaves the server on :{PORT} (pid {server}) running; sessions continue.")
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
