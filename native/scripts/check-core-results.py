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
    ids = [dest for row in mapping["mappings"] for dest in row["destinations"]] + mapping["added"] + mapping.get("upstreamAdded", [])
    expected = []
    parameterized = set()
    for raw in ids:
        module, _, suite, signature = json.loads(raw)
        if module == target:
            expected.append(identity(suite, signature))
            if signature.split("(", 1)[1].split(")", 1)[0].strip():
                parameterized.add(identity(suite, signature))
    if not expected or len(set(expected)) != len(expected):
        raise ValueError("empty or ambiguous mapped test identities")
    return set(expected), parameterized


def expected_arguments(path, target, parameterized):
    inventory = json.loads(Path(path).read_text())
    if (not isinstance(inventory, dict) or type(inventory.get("schemaVersion")) is not int or
            inventory["schemaVersion"] != 1 or
            inventory.get("target") != target or not isinstance(inventory.get("arguments"), dict)):
        raise ValueError("unknown parameter inventory schema/target")
    arguments = inventory["arguments"]
    if set(arguments) != parameterized:
        raise ValueError("parameter inventory does not match mapped parameterized declarations")
    if any(not isinstance(names, list) or not names or
           any(not isinstance(name, str) or not name for name in names)
           for names in arguments.values()):
        raise ValueError("invalid expected parameter arguments")
    return {key: Counter(names) for key, names in arguments.items()}


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
    arguments = {}
    containers = {"Test Plan", "Unit test bundle", "Test Suite"}
    allowed_children = {
        None: {"Test Plan", "Test Case"},  # Also support a flat case inventory.
        "Test Plan": {"Unit test bundle"},
        "Unit test bundle": {"Test Suite", "Test Case"},
        "Test Suite": {"Test Suite", "Test Case"},
        "Test Case": {"Arguments"},
        "Arguments": set(),
    }

    def walk(nodes, parent=None, case=None):
        for node in nodes:
            if not isinstance(node, dict) or not isinstance(node.get("nodeType"), str):
                raise ValueError("unknown xcresult node schema")
            kind = node["nodeType"]
            if kind not in containers | {"Test Case", "Arguments"}:
                raise ValueError(f"unknown xcresult node type: {kind}")
            if kind not in allowed_children[parent]:
                raise ValueError("unknown xcresult node structure")
            if node.get("result") not in ("Passed", "Skipped", "Failed"):
                raise ValueError("unknown test result")
            if kind in ("Test Case", "Arguments"):
                if kind == "Test Case":
                    suite, signature = node["nodeIdentifier"].rsplit("/", 1)
                    case = identity(suite, signature)
                    rows.append((case, node["result"]))
                else:
                    name = node.get("name")
                    if not isinstance(name, str) or not name:
                        raise ValueError("unknown parameter argument identity")
                    arguments.setdefault(case, Counter())[name] += 1
                    if node["result"] != "Passed":
                        raise ValueError("parameter argument did not pass")
            elif node["result"] == "Failed":
                raise ValueError("xcresult container did not pass")
            if kind in containers and "children" not in node:
                raise ValueError("unknown xcresult container structure")
            children = node.get("children", [])
            if not isinstance(children, list):
                raise ValueError("unknown xcresult children schema")
            walk(children, kind, case)
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
    parser.add_argument("--parameters", default=Path(__file__).resolve().parents[1] / "Tests/Conservation/issue-2431-core-parameters.json")
    parser.add_argument("--require-keychain", action="store_true")
    args = parser.parse_args()
    try:
        expected, parameterized = expected_identities(args.mapping, args.target)
        if args.xunit and not (args.summary or args.tests):
            summary, rows = xunit_rows(args.xunit, args.target)
            detail = ("parameter arguments aggregated by Swift Testing xUnit; "
                      "per-argument coverage UNVERIFIED here; core requires the simulator xcresult gate")
        elif args.summary and args.tests and not args.xunit:
            summary = json.loads(Path(args.summary).read_text())
            rows, arguments = xcresult_rows(json.loads(Path(args.tests).read_text()))
            required = expected_arguments(args.parameters, args.target, parameterized)
            if arguments != required:
                mismatches = sorted(key for key in arguments.keys() | required.keys()
                                    if arguments.get(key) != required.get(key))
                raise ValueError(f"parameter argument inventory mismatch: {mismatches[:5]}")
            detail = (f"parameterized declarations={len(arguments)}; "
                      f"parameter argument executions={sum(sum(names.values()) for names in arguments.values())}")
        else:
            raise ValueError("provide summary AND tests JSON, or --xunit XML; counts alone are insufficient")
        print(validate(summary, rows, expected, args.target, args.require_keychain) + "; " + detail)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, ET.ParseError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
