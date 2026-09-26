#!/usr/bin/env python3
"""Select available iOS >=18 devices without substituting a different family."""
import argparse
import json
import re
import sys


def select(payload, family):
    if not isinstance(payload, dict) or not isinstance(payload.get("devices"), dict):
        raise ValueError("unknown simctl schema")
    candidates = []
    for runtime, devices in payload["devices"].items():
        match = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)", runtime)
        if not match:
            continue
        version = tuple(int(part) for part in match[1].split("-"))
        if version < (18,):
            continue
        if not isinstance(devices, list) or any(not isinstance(d, dict) for d in devices):
            raise ValueError("invalid device list")
        for device in devices:
            name, udid = device.get("name"), device.get("udid")
            if device.get("isAvailable") is not True or not isinstance(name, str) or not isinstance(udid, str) or not udid:
                continue
            if family == "iPhone":
                matches = name.startswith("iPhone") and "Duo" not in name
            elif family == "iPad":
                matches = name.startswith("iPad")
            else:
                # Only select an explicit surface supplied by the installed simulator.
                # Never infer inner/outer mode from an ordinary iPhone destination.
                surface = "outer" if family == "DuoOuter" else "inner"
                matches = version >= (27, 1) and "iPhone Duo" in name and surface in name.lower()
            if matches:
                candidates.append((version + (0,) * (3 - len(version)), name, udid, runtime))
    if not candidates:
        raise ValueError(f"no available {family} destination; install/configure its simulator surface")
    return sorted(candidates, key=lambda item: (tuple(-v for v in item[0]), item[1], item[2]))[0]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("devices")
    parser.add_argument("--family", choices=("iPhone", "iPad", "DuoOuter", "DuoInner"), required=True)
    args = parser.parse_args()
    try:
        with open(args.devices, encoding="utf-8") as source:
            _, name, udid, runtime = select(json.load(source), args.family)
        print(f"{runtime}: {name}", file=sys.stderr)
        print(udid)
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"UNMET: {error}", file=sys.stderr)
        sys.exit(1)
