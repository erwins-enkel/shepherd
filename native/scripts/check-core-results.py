#!/usr/bin/env python3
"""Fail closed on missing mapped identities, unknown results, skips or failures.

The conservation check independently verifies this mapping against current Swift
source. Runtime normalization follows the accepted Task2 identity bijection:
outer suite paths plus function name; ambiguous/duplicate names fail closed.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


KEYCHAIN_SKIPS = {
    "CredentialStoreTests/keychainRoundTrip",
    "CredentialStoreTests/keychainSaveUpdatesInPlace",
}


def identity(suite, signature):
    if not isinstance(suite, str) or not suite or not isinstance(signature, str) or "(" not in signature:
        raise ValueError("unknown test identity schema")
    return suite.replace("/", ".") + "/" + signature.split("(")[0]


def expected_identities(path, target):
    mapping = json.loads(Path(path).read_text())
    ids = [dest for row in mapping["mappings"] for dest in row["destinations"]] + mapping["added"]
    expected = []
    for raw in ids:
        module, _, suite, signature = json.loads(raw)
        if module == target:
            expected.append(identity(suite, signature))
    if not expected or len(set(expected)) != len(expected):
        raise ValueError("empty or ambiguous mapped test identities")
    return set(expected)


def check(summary):
    fields = ("passedTests", "failedTests", "skippedTests", "totalTestCount")
    if not isinstance(summary, dict) or any(type(summary.get(key)) is not int or summary[key] < 0 for key in fields):
        raise ValueError("unknown xcresult summary schema or invalid test counts")
    passed, failed, skipped, total = (summary[key] for key in fields)
    if total <= 0 or passed <= 0 or failed != 0:
        raise ValueError(f"tests did not pass: passed={passed} failed={failed} skipped={skipped} total={total}")
    if passed + failed + skipped != total:
        raise ValueError("inconsistent test counts")
    return f"passed={passed} failed={failed} skipped={skipped} total={total}"


def xcresult_rows(tree):
    if not isinstance(tree, dict) or not isinstance(tree.get("testNodes"), list):
        raise ValueError("unknown xcresult tests schema")
    rows = []
    arguments = 0

    def walk(nodes):
        nonlocal arguments
        for node in nodes:
            if not isinstance(node, dict) or not isinstance(node.get("nodeType"), str):
                raise ValueError("unknown xcresult node schema")
            kind = node["nodeType"]
            if kind in ("Test Case", "Arguments"):
                if node.get("result") not in ("Passed", "Skipped", "Failed"):
                    raise ValueError("unknown test result")
                if kind == "Test Case":
                    suite, signature = node["nodeIdentifier"].rsplit("/", 1)
                    rows.append((identity(suite, signature), node["result"]))
                else:
                    arguments += 1
                    if node["result"] != "Passed":
                        raise ValueError("parameter argument did not pass")
            children = node.get("children", [])
            if not isinstance(children, list):
                raise ValueError("unknown xcresult children schema")
            walk(children)
    walk(tree["testNodes"])
    return rows, arguments


def xunit_rows(path, target):
    root = ET.parse(path).getroot()
    if root.tag != "testsuites" or len(root) != 1 or root[0].tag != "testsuite":
        raise ValueError("unknown Swift Testing xUnit schema")
    suite = root[0]
    counts = {key: int(suite.attrib[attr]) for key, attr in (
        ("totalTestCount", "tests"), ("failedTests", "failures"), ("skippedTests", "skipped"))}
    if int(suite.attrib["errors"]) != 0:
        raise ValueError("xUnit reports test errors")
    # Swift Testing counts executed declarations in tests, with skipped separate.
    counts["passedTests"] = counts["totalTestCount"] - counts["failedTests"]
    counts["totalTestCount"] += counts["skippedTests"]
    rows = []
    for case in suite:
        if case.tag != "testcase" or not case.attrib["classname"].startswith(target + "."):
            raise ValueError("unexpected xUnit test target/schema")
        tags = [child.tag for child in case]
        if any(tag not in ("skipped", "failure", "system-out", "system-err") for tag in tags):
            raise ValueError("unknown xUnit result")
        state = "Failed" if "failure" in tags else "Skipped" if "skipped" in tags else "Passed"
        rows.append((identity(case.attrib["classname"][len(target) + 1:], case.attrib["name"]), state))
    return counts, rows


def validate(summary, rows, expected, target, require_keychain=False):
    message = check(summary)
    observed = [key for key, _ in rows]
    if len(set(observed)) != len(observed):
        raise ValueError("duplicate runtime identity")
    missing, extra = expected - set(observed), set(observed) - expected
    if missing or extra:
        raise ValueError(f"runtime identity mismatch: missing={len(missing)} extra={len(extra)}; "
                         f"missing sample={sorted(missing)[:5]} extra sample={sorted(extra)[:5]}")
    counts = Counter(state for _, state in rows)
    if (len(rows), counts["Passed"], counts["Skipped"], counts["Failed"]) != (
            summary["totalTestCount"], summary["passedTests"], summary["skippedTests"], summary["failedTests"]):
        raise ValueError("summary disagrees with runtime identities/results")
    allowed_skips = KEYCHAIN_SKIPS if target == "ShepherdKitTests" and not require_keychain else set()
    skipped = {key for key, state in rows if state == "Skipped"}
    if skipped - allowed_skips:
        raise ValueError("unexpected skipped identities: " + str(sorted(skipped - allowed_skips)))
    if require_keychain and (target != "ShepherdKitTests" or
                            ("CredentialStoreTests/keychainIsUsableOnCI", "Passed") not in rows):
        raise ValueError("Kit CI Keychain sentinel did not execute successfully")
    return f"{message} identities={len(rows)}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summary", nargs="?")
    parser.add_argument("tests", nargs="?")
    parser.add_argument("--xunit")
    parser.add_argument("--target", choices=("ShepherdAppCoreTests", "ShepherdKitTests"), default="ShepherdAppCoreTests")
    parser.add_argument("--mapping", default=Path(__file__).resolve().parents[1] / "Tests/Conservation/issue-2431-map.json")
    parser.add_argument("--require-keychain", action="store_true")
    args = parser.parse_args()
    try:
        expected = expected_identities(args.mapping, args.target)
        if args.xunit and not (args.summary or args.tests):
            summary, rows = xunit_rows(args.xunit, args.target)
            detail = "parameter arguments aggregated by Swift Testing xUnit"
        elif args.summary and args.tests and not args.xunit:
            summary = json.loads(Path(args.summary).read_text())
            rows, arguments = xcresult_rows(json.loads(Path(args.tests).read_text()))
            detail = f"parameter argument executions={arguments}"
        else:
            raise ValueError("provide summary AND tests JSON, or --xunit XML; counts alone are insufficient")
        print(validate(summary, rows, expected, args.target, args.require_keychain) + "; " + detail)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, ET.ParseError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
