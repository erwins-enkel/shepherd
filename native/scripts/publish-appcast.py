#!/usr/bin/env python3
"""Publish an appcast to a dedicated branch without weakening immutable releases."""
import base64
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

BRANCH = "macos-update-feed"
VERSION = "{http://www.andymatuschak.org/xml-namespaces/sparkle}version"


def build_number(feed):
    versions = ET.fromstring(feed).findall(f"./channel/item/{VERSION}")
    if not versions or any(not (v.text or "").isdigit() for v in versions):
        raise ValueError("Appcast must contain numeric build versions")
    return max(int(v.text) for v in versions)


def should_publish(previous, incoming):
    new = build_number(incoming)
    if previous is None:
        return True
    old = build_number(previous)
    if new < old:
        raise ValueError("Refusing to roll back the update feed")
    if new == old:
        if previous != incoming:
            raise ValueError("Refusing different metadata for an already published build")
        return False
    return True


def api(endpoint, payload=None, paginate=False):
    command = ["gh", "api", endpoint]
    if paginate:
        command += ["--paginate", "--slurp"]
    if payload is not None:
        command += ["--method", "POST", "--input", "-"]
    result = subprocess.run(command, input=None if payload is None else json.dumps(payload),
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def publish(repo, path):
    incoming = Path(path).read_bytes()
    build_number(incoming)
    base = f"repos/{repo}"
    # Listing distinguishes a first publication from an auth/network failure.
    branches = api(f"{base}/branches?per_page=100", paginate=True)
    exists = any(b["name"] == BRANCH for page in branches for b in page)
    if exists:
        current = api(f"{base}/contents/appcast.xml?ref={BRANCH}")
        previous = base64.b64decode(current["content"])
        if not should_publish(previous, incoming):
            print("Feed already current; no change")
            return
        # The blob SHA fences concurrent changes; a stale writer fails closed.
        payload = {"message": f"Publish Mac build {build_number(incoming)}",
                   "branch": BRANCH, "sha": current["sha"],
                   "content": base64.b64encode(incoming).decode()}
        subprocess.run(["gh", "api", f"{base}/contents/appcast.xml", "--method", "PUT",
                        "--input", "-"], input=json.dumps(payload), text=True,
                       stdout=subprocess.DEVNULL, check=True)
    else:
        tree = api(f"{base}/git/trees", {"tree": [{"path": "appcast.xml", "mode": "100644",
                    "type": "blob", "content": incoming.decode()}]})
        commit = api(f"{base}/git/commits", {"message": "Initialize Mac update feed",
                     "tree": tree["sha"], "parents": []})
        api(f"{base}/git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]})
    print(f"Published Mac build {build_number(incoming)}")


if __name__ == "__main__":
    publish(sys.argv[1], sys.argv[2])
