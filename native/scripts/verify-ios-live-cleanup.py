#!/usr/bin/env python3
"""Verify only this isolated iOS run's token; never print credential values."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class Unmet(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_size > 65536:
            raise Unmet("cleanup ownership or private-file permissions invalid")
        return json.load(stream)


def server_url(raw):
    url = urllib.parse.urlsplit(raw)
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise Unmet("invalid live server address")
    host = url.hostname.lower().rstrip(".")
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    if url.scheme != "https" and not (url.scheme == "http" and (loopback or host.endswith(".ts.net"))):
        raise Unmet("live server violates remote URL policy")
    return urllib.parse.urlunsplit((url.scheme, url.netloc, "", "", ""))


def status_code(url, token, method):
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token}, method=method)
    # No redirects: never forward a live bearer to an unrelated origin.
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def write_status(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".ios-proof-", dir=str(Path(path).parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(value, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify(handoff_path, proof_path, run_id, base_url, revoke=False):
    handoff = private_json(handoff_path)
    expected_url = server_url(base_url)
    if (not isinstance(handoff, dict) or handoff.get("runID") != run_id
            or not isinstance(handoff.get("tokenID"), str) or not handoff["tokenID"]
            or not isinstance(handoff.get("token"), str) or not handoff["token"]
            or server_url(handoff.get("baseURL", "")) != expected_url):
        raise Unmet("cleanup ownership does not match this run")
    token_id = handoff["tokenID"]
    token = handoff["token"]
    if revoke:
        # Revoke exactly the recorded owned token. A refusal is not proof of cleanup.
        try:
            status_code(expected_url + "/api/access-tokens/" + urllib.parse.quote(token_id, safe=""), token, "DELETE")
        except (OSError, ValueError):
            pass
    for attempt in range(3):
        try:
            status = status_code(expected_url + "/api/sessions", token, "GET")
        except (OSError, ValueError):
            status = None
        if status == 401:
            write_status(proof_path, {"runID": run_id, "tokenID": token_id, "phase": "verified", "verifiedHTTPStatus": 401})
            return
        if attempt < 2:
            time.sleep(0.2)
    raise Unmet("owned-token cleanup lacks HTTP-401 proof")


def run_harness(config_path):
    allowed = Path.home() / ".config/shepherd/codex/live-smoke.json"
    if Path(config_path).expanduser().absolute() != allowed:
        raise Unmet("only the operator-named live-smoke configuration may be read")
    config = private_json(allowed)
    if not isinstance(config, dict):
        raise Unmet("live-smoke config must be an object")
    # The operator-managed file predates this harness and uses snake_case names;
    # accept both spellings without ever printing any value.
    configured_url = config.get("baseURL", config.get("base_url"))
    configured_password = config.get("password", config.get("operator_password"))
    if not isinstance(configured_url, str) or not isinstance(configured_password, str) or not configured_password:
        raise Unmet("live-smoke config must provide baseURL and password")
    base_url = server_url(configured_url)
    run_id = str(uuid.uuid4())
    directory = Path(tempfile.mkdtemp(prefix="shepherd-ios-live-"))
    handoff, app_status, proof = (directory / name for name in ("owned-token.json", "app-status.json", "cleanup-proof.json"))
    environment = os.environ.copy()
    values = {"SHEPHERD_LIVE_BASE_URL": base_url, "SHEPHERD_LIVE_PASSWORD": configured_password,
              "SHEPHERD_IOS_RUN_ID": run_id, "SHEPHERD_IOS_CLEANUP_STATUS_PATH": str(app_status),
              "SHEPHERD_IOS_TOKEN_HANDOFF_PATH": str(handoff), "SHEPHERD_ISOLATED": "1"}
    for name, value in values.items():
        environment[name] = value
        environment["TEST_RUNNER_" + name] = value
    environment["SHEPHERD_IOS_LIVE_HARNESS"] = "1"
    script = Path(__file__).with_name("test-ios-app.sh")
    result = directory / "live.xcresult"
    # Keep all live subprocess diagnostics private; never echo raw app/test output.
    old_term = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    exit_code = 1
    try:
        log_fd = os.open(directory / "private-test.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(log_fd, "w") as log:
            exit_code = subprocess.run([str(script), "live", "--result-bundle-path", str(result)], env=environment, stdout=log, stderr=subprocess.STDOUT, check=False).returncode
    finally:
        signal.signal(signal.SIGTERM, old_term)
        try:
            verify(handoff, proof, run_id, base_url, revoke=True)
        except (OSError, ValueError, Unmet):
            print(f"UNMET: cleanup unverified; run={run_id}; private evidence={directory}", file=sys.stderr)
            raise Unmet("live acceptance incomplete; retain private handoff for owned-token cleanup") from None
        else:
            handoff.unlink()
            print(f"Owned-token HTTP-401 cleanup verified; run={run_id}")
    if exit_code:
        raise Unmet("live UI assertions failed; token cleanup verified")
    print(f"Live assertions and cleanup passed; private evidence={directory}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--config")
    parser.add_argument("--handoff")
    parser.add_argument("--status")
    parser.add_argument("--run-id")
    parser.add_argument("--server-url")
    parser.add_argument("--revoke", action="store_true")
    args = parser.parse_args()
    try:
        if args.run and args.config:
            run_harness(args.config)
        elif not args.run and all((args.handoff, args.status, args.run_id, args.server_url)):
            verify(args.handoff, args.status, args.run_id, args.server_url, args.revoke)
            print("Owned-token HTTP-401 cleanup verified")
        else:
            raise Unmet("provide a complete isolated cleanup invocation")
    except (OSError, ValueError, TypeError, KeyError, Unmet) as error:
        message = str(error) if isinstance(error, Unmet) else "private cleanup input or request failed"
        print("UNMET: " + message, file=sys.stderr)
        sys.exit(1)
