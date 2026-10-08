# shellcheck shell=bash
#
# Sourced by test-app.sh. Stops a run that includes the XCUITest bundle before
# xcodebuild starts when macOS would first ask to "Enable UI Automation" with
# Touch ID or a password — a dialog an unattended run has nobody to answer.
#
# macOS caches that authentication for only about 8 hours, so the dialog keeps
# coming back until an administrator sets the Mac up once with
#   automationmodetool enable-automationmode-without-authentication
# No script ever runs that: it changes a Mac-wide setting and stays a deliberate
# operator decision. See native/docs/development.md, "UI Automation Mode".

# Prints one of three states:
#   ready    automationmodetool reports that enabling Automation Mode DOES NOT
#            REQUIRE authentication — the same positive check GitHub's
#            actions/runner-images makes after setting up its runners.
#   prompts  the tool ran fine, but without that text.
#   unknown  the tool is missing, failed, or printed nothing (a sandbox, say).
# The tool's exit status is undocumented, so only the positive text means ready.
shepherd_automation_mode() {
  local output status=0
  output="$(automationmodetool 2>/dev/null)" || status=$?
  case "$output" in
    *"DOES NOT REQUIRE"*) echo ready ;;
    "") echo unknown ;;
    *) if [ "$status" -eq 0 ]; then echo prompts; else echo unknown; fi ;;
  esac
}

# Succeeds when the xcodebuild arguments in "$@" leave the UI bundle in the run:
# any -only-testing:ShepherdUITests…, or neither an -only-testing: filter nor
# -skip-testing:ShepherdUITests.
shepherd_runs_ui_tests() {
  local arg filtered=0
  for arg in "$@"; do
    case "$arg" in
      -only-testing:ShepherdUITests*) return 0 ;;
      -only-testing:* | -skip-testing:ShepherdUITests) filtered=1 ;;
    esac
  done
  [ "$filtered" -eq 0 ]
}

# Returns 1, after saying why and naming every way out, when the run includes
# UI tests and the Mac would prompt. Warns and returns 0 when the override is
# set or the status cannot be read: a state nobody can check blocks nothing.
shepherd_automation_preflight() {
  shepherd_runs_ui_tests "$@" || return 0

  case "$(shepherd_automation_mode)" in
    ready) return 0 ;;
    unknown)
      echo "warning: could not read the UI Automation status (automationmodetool);" >&2
      echo "         if macOS asks to \"Enable UI Automation\", someone has to answer it." >&2
      return 0
      ;;
  esac

  if [ "${SHEPHERD_ALLOW_AUTOMATION_PROMPT:-}" = "1" ]; then
    echo "warning: this Mac asks to \"Enable UI Automation\" before the UI tests;" >&2
    echo "         SHEPHERD_ALLOW_AUTOMATION_PROMPT=1 is set, so answer the dialog." >&2
    return 0
  fi

  echo "UNMET: this run includes the UI tests (ShepherdUITests), and macOS would stop" >&2
  echo "       it with an \"Enable UI Automation\" dialog that an unattended run" >&2
  echo "       cannot answer. Set this Mac up once, in an administrator's Terminal:" >&2
  echo "         automationmodetool enable-automationmode-without-authentication" >&2
  echo "       or run only the unit tests:" >&2
  echo "         native/scripts/test-app.sh -only-testing:ShepherdTests" >&2
  echo "       or, with someone at the Mac to answer the dialog:" >&2
  echo "         SHEPHERD_ALLOW_AUTOMATION_PROMPT=1 <the command you just ran>" >&2
  echo "       See native/docs/development.md, \"UI Automation Mode\"." >&2
  return 1
}
