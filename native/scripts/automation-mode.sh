# shellcheck shell=bash
#
# Sourced by test-app.sh. Decides whether this run may start XCUITest at all.
#
# XCUITest drives the app through UI Automation, and macOS guards that with an
# "Enable UI Automation" Touch ID / password dialog. The authentication is only
# cached for about eight hours, so on a Mac that was never set up the dialog
# comes back again and again, and an unattended run sits on it until it times
# out. An administrator can lift the requirement once for the whole Mac:
#
#   automationmodetool enable-automationmode-without-authentication
#
# No script here ever runs that; it is the operator's decision. This file only
# reads the state and stops a run that would hang on the dialog.

# What `shepherd_automation_mode` found: "ready" (no authentication needed),
# "prompts" (macOS will ask) or "unknown" (the state could not be read).
SHEPHERD_AUTOMATION_MODE="unknown"

# Sets SHEPHERD_AUTOMATION_MODE. Only stdout counts, and only the positive text:
# this is the same check GitHub's runner images use
# (`"$(automationmodetool)" =~ "DOES NOT REQUIRE"`), and the tool's exit code is
# not documented. A missing tool, a failing call or a silent one — a sandbox,
# say — is "unknown", never "prompts".
shepherd_automation_mode() {
  SHEPHERD_AUTOMATION_MODE="unknown"
  command -v automationmodetool >/dev/null 2>&1 || return 0

  local report
  report="$(automationmodetool 2>/dev/null)" || return 0
  [ -n "$report" ] || return 0

  case "$report" in
    *"DOES NOT REQUIRE"*) SHEPHERD_AUTOMATION_MODE="ready" ;;
    *) SHEPHERD_AUTOMATION_MODE="prompts" ;;
  esac
}

# Succeeds when the xcodebuild arguments in "$@" run any of ShepherdUITests:
# with no -only-testing: filter unless the whole bundle is skipped, and with any
# -only-testing: filter that names it. -only-testing:ShepherdTests alone does not.
shepherd_runs_ui_tests() {
  local arg only=0 skip=0
  for arg in "$@"; do
    case "$arg" in
      -only-testing:ShepherdUITests | -only-testing:ShepherdUITests/*) return 0 ;;
      -only-testing:*) only=1 ;;
      -skip-testing:ShepherdUITests) skip=1 ;;
    esac
  done
  [ "$only" -eq 0 ] && [ "$skip" -eq 0 ]
}

# Returns 1, after saying why and naming every way out, when "$@" runs UI tests
# on a Mac that would ask for UI Automation authentication. Every other case
# returns 0: a unit-only run never even reads the state, a set-up Mac is silent,
# and an unreadable state or SHEPHERD_ALLOW_AUTOMATION_PROMPT=1 only warns.
shepherd_automation_preflight() {
  shepherd_runs_ui_tests "$@" || return 0
  shepherd_automation_mode

  case "$SHEPHERD_AUTOMATION_MODE" in
    ready) return 0 ;;
    unknown)
      echo "warning: could not read the UI Automation state (automationmodetool is missing," >&2
      echo "         failed or printed nothing); running the UI tests anyway. If macOS shows" >&2
      echo "         an \"Enable UI Automation\" dialog, see" >&2
      echo "         native/docs/development.md#ui-automation-mode" >&2
      return 0
      ;;
  esac

  if [ "${SHEPHERD_ALLOW_AUTOMATION_PROMPT:-}" = "1" ]; then
    echo "warning: UI Automation on this Mac still asks for authentication; running anyway" >&2
    echo "         because SHEPHERD_ALLOW_AUTOMATION_PROMPT=1. Answer the \"Enable UI" >&2
    echo "         Automation\" dialog when it appears." >&2
    return 0
  fi

  echo "UNMET: this run includes UI tests (ShepherdUITests), but UI Automation on this Mac" >&2
  echo "       still asks for authentication. XCUITest would stop at an \"Enable UI" >&2
  echo "       Automation\" dialog, and an unattended run would simply hang there." >&2
  echo >&2
  echo "       Set this Mac up once, in an administrator's Terminal:" >&2
  echo "         automationmodetool enable-automationmode-without-authentication" >&2
  echo "       or run only the unit tests:" >&2
  echo "         native/scripts/test-app.sh -only-testing:ShepherdTests" >&2
  echo "       or, if you are at this Mac to answer the dialog:" >&2
  echo "         SHEPHERD_ALLOW_AUTOMATION_PROMPT=1 <the command you just ran>" >&2
  echo "       See native/docs/development.md#ui-automation-mode" >&2
  return 1
}
