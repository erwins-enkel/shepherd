#!/usr/bin/env python3
"""Fail closed unless xcresulttool reports executed, successful core tests."""
import json
import sys


def check(summary):
    fields = ("passedTests", "failedTests", "skippedTests", "totalTestCount")
    if not isinstance(summary, dict) or any(type(summary.get(key)) is not int or summary[key] < 0 for key in fields):
        raise ValueError("unknown xcresult summary schema or invalid test counts")
    passed, failed, skipped, total = (summary[key] for key in fields)
    if total <= 0 or passed <= 0 or failed != 0:
        raise ValueError(f"core tests did not pass: passed={passed} failed={failed} skipped={skipped} total={total}")
    if passed + failed + skipped != total:
        raise ValueError("inconsistent xcresult test counts")
    return f"passed={passed} failed={failed} skipped={skipped} total={total}"


if __name__ == "__main__":
    try:
        with open(sys.argv[1], encoding="utf-8") as source:
            print(check(json.load(source)))
    except (IndexError, OSError, ValueError, TypeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
