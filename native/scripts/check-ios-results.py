#!/usr/bin/env python3
"""Require exact executed iOS test identities, successful counts and no skips."""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location("core_results", Path(__file__).with_name("check-core-results.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def source_inventory(directory, suite_filter=None):
    """The iOS target uses nonparameterized, one top-level test suite per file.

    Fail closed when a declaration cannot be mapped; do not silently erase tests.
    Explicit --expected inventories remain available for parameterized suites.
    """
    expected = []
    for path in sorted(Path(directory).glob("*.swift")):
        source = path.read_text()
        suites = re.findall(r"(?:final\s+)?(?:class|struct)\s+(\w+)(?:\s*:\s*XCTestCase)?\s*\{", source)
        methods = re.findall(r"\bfunc\s+(test\w+)\s*\(\s*\)", source)
        methods += re.findall(r"@Test(?:\([^\n]*\))?\s*(?:@MainActor\s*)?func\s+(\w+)\s*\(\s*\)", source)
        if not methods:
            if "@Test" in source or "XCTestCase" in source:
                raise ValueError(f"unmapped test declarations in {path.name}; provide an explicit inventory")
            continue
        if len(suites) != 1 or len(set(methods)) != len(methods):
            raise ValueError(f"ambiguous source inventory in {path.name}; provide an explicit inventory")
        if suite_filter and suites[0] not in suite_filter:
            continue
        expected.extend(f"{suites[0]}/{name}" for name in methods)
    if not expected:
        raise ValueError("empty expected source inventory")
    return expected


def validate(summary, tree, expected):
    counts = core.check(summary)
    if not isinstance(expected, list) or not expected or any(not isinstance(v, str) or not v for v in expected) or len(set(expected)) != len(expected):
        raise ValueError("empty or duplicate expected identity inventory")
    rows, arguments = core.xcresult_rows(tree)
    if arguments:
        raise ValueError("parameterized iOS tests require an explicit argument validator")
    actual = [name for name, _ in rows]
    if len(set(actual)) != len(actual) or set(actual) != set(expected):
        raise ValueError("runtime identity mismatch: missing=" + str(sorted(set(expected) - set(actual))) + " extra=" + str(sorted(set(actual) - set(expected))))
    states = Counter(state for _, state in rows)
    if states["Failed"] or states["Skipped"]:
        raise ValueError("failed or skipped iOS test identities")
    if len(rows) != summary["totalTestCount"] or states["Passed"] != summary["passedTests"] or summary["skippedTests"]:
        raise ValueError("summary disagrees with executed identities")
    return counts + f" identities={len(rows)}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summary")
    parser.add_argument("tests")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--expected")
    group.add_argument("--source-root")
    parser.add_argument("--suite", action="append")
    args = parser.parse_args()
    try:
        expected = json.loads(Path(args.expected).read_text()) if args.expected else source_inventory(args.source_root, args.suite)
        print(validate(json.loads(Path(args.summary).read_text()), json.loads(Path(args.tests).read_text()), expected))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
