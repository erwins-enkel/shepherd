#!/usr/bin/env python3
"""Select a deterministic available iPhone on iOS 18 or later from simctl JSON."""
import json
import re
import sys


def select(payload):
    devices = payload.get("devices")
    if not isinstance(devices, dict):
        raise ValueError("unknown simctl schema: missing devices object")
    candidates = []
    for runtime, entries in devices.items():
        match = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)", runtime)
        if not match:
            continue
        version = tuple(int(part) for part in match[1].split("-"))
        if version[0] < 18:
            continue
        for device in entries:
            name, udid = device.get("name"), device.get("udid")
            if device.get("isAvailable") is True and isinstance(name, str) and name.startswith("iPhone") and isinstance(udid, str) and udid:
                candidates.append((version + (0,) * (3 - len(version)), name, udid, runtime))
    if not candidates:
        raise ValueError("no available iPhone simulator on iOS 18 or later")
    return sorted(candidates, key=lambda item: (tuple(-part for part in item[0]), item[1], item[2]))[0]


if __name__ == "__main__":
    try:
        with open(sys.argv[1], encoding="utf-8") as source:
            version, name, udid, runtime = select(json.load(source))
        print(f"{runtime}: {name}", file=sys.stderr)
        print(udid)
    except (IndexError, OSError, ValueError, TypeError, KeyError) as error:
        print(f"UNMET: {error}", file=sys.stderr)
        sys.exit(1)
