# shellcheck shell=bash
#
# The one place a keychain password is read and handed to `security`. Sourced by
# dev-signing-identity.sh and codesign-mode.sh; nothing else should ever touch
# one of these files.
#
# Two rules, both of which the obvious spelling
# `security unlock-keychain -p "$(cat "$file")" "$keychain"` breaks:
#
#   1. **Never in argv.** `ps` shows every process's full command line to every
#      user on the machine, so an option value is readable for as long as the
#      call runs. `security`'s own help says so: "Use of the -p option is
#      insecure". `security -i` reads its command lines from STDIN and runs them
#      in-process, so the only argv anyone can see is `security -i`.
#   2. **Never in an xtrace log.** `set -x` prints every command after
#      expansion, so a build run with `bash -x` — or a CI job that turns tracing
#      on globally — would echo the password. The helper below disables tracing
#      before the value exists and restores the caller's setting afterwards, so
#      the window in which a secret is in a variable is never a traced one.

# Runs one `security` command with the contents of a password file substituted
# for the literal token `%PASS%`. The first argument after the password file is
# the `security` subcommand; every argument after it is quoted for `security -i`.
#
#   shepherd_security_with_pass <pass-file> unlock-keychain -p %PASS% <keychain>
#
# Returns the exit status of the `security` subcommand (`security -i` propagates
# it), or 1 when the password file cannot be read. stderr is left alone: a
# failing subcommand prints its own name and status, never its arguments.
shepherd_security_with_pass() {
  local pass_file="$1"
  shift

  # Read `$-` BEFORE disabling tracing — this line carries no secret itself.
  local had_xtrace=""
  case "$-" in
    *x*) had_xtrace=yes ;;
  esac
  { set +x; } 2>/dev/null

  local status=0 pass line arg
  if pass="$(cat "$pass_file" 2>/dev/null)"; then
    # `security -i` re-parses the line, so every argument after the subcommand
    # name is double-quoted — a keychain path under a $HOME with a space in it
    # would otherwise arrive as two arguments. Nothing here needs escaping
    # beyond that: the paths are ours, and both password files this repo writes
    # hold base64 or hex from `openssl rand`.
    line="$1"
    shift
    for arg in "$@"; do
      if [ "$arg" = "%PASS%" ]; then arg="$pass"; fi
      line="$line \"$arg\""
    done
    printf '%s\n' "$line" | security -i || status=$?
  else
    status=1
  fi
  unset pass line arg

  [ -z "$had_xtrace" ] || set -x
  return "$status"
}
