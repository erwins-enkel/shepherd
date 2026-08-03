#!/usr/bin/env bash
# Prices the RESIDENT PREFIX of a drain-shaped Claude Code spawn under the trim variants
# (issue #2001, epic #2005). The prompt-budget instrument (src/prompt-budget.ts) measures
# Shepherd's own payload; this measures the other side — what Claude Code itself puts in
# front of every turn (tools, skill catalog, plugin injections, CLAUDE.md).
#
# Method: one `claude -p` round-trip per variant with a trivial prompt, reading the usage
# the CLI reports. "prefix" = input + cache_creation + cache_read, i.e. everything resident
# before the turn's work. Numbers are MACHINE-SPECIFIC (they scale with the operator's own
# plugins and skills) and CLI-VERSION-specific — re-run after a Claude Code bump rather than
# quoting an old figure.
#
# Usage:  scripts/measure-spawn-prefix.sh [-n reps] [variant ...]
#   today     `--disable-slash-commands` + every plugin off   (the pre-#2001 trim)
#   surgical  skills on, bundled + user-level skills off, plugins off  (the #2001 trim)
#   naive     skills on, plugins off                          (the rejected alternative)
#   none      no trim at all
# Defaults to one rep of every variant, in the target repo (cwd, or $REPO).
set -euo pipefail

REPO="${REPO:-$PWD}"
PROMPT='Reply with exactly: OK'
reps=1
[ "${1:-}" = "-n" ] && { reps="$2"; shift 2; }
variants=("$@")
[ ${#variants[@]} -eq 0 ] && variants=(today surgical naive none)

# Every plugin the operator enabled globally -> false, exactly like the spawn overlay does.
plugins_off() {
  python3 - "$HOME/.claude/settings.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        enabled = json.load(f).get("enabledPlugins") or {}
except OSError:
    enabled = {}
print(json.dumps({k: False for k in enabled}))
PY
}

# User-level skill names -> "off". Identity is the SKILL.md frontmatter `name`, falling back
# to the directory entry — the rule src/commands.ts encodes and skillOverrides is keyed by.
user_skills_off() {
  python3 - "$HOME/.claude/skills" <<'PY'
import json, os, re, sys
root, names = sys.argv[1], []
for entry in sorted(os.listdir(root) if os.path.isdir(root) else []):
    path = os.path.join(root, entry, "SKILL.md")
    try:
        with open(path, encoding="utf8") as f:
            head = f.read(4096)
    except OSError:
        continue
    m = re.search(r"^name\s*:\s*(.*)$", head, re.M)
    name = (m.group(1).strip().strip("\"'") if m else "") or entry
    names.append(name)
print(json.dumps({n: "off" for n in names}))
PY
}

settings_for() {
  python3 - "$1" "$(plugins_off)" "$(user_skills_off)" <<'PY'
import json, sys
variant, plugins, skills = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
s = {}
if variant != "none":
    s["enabledPlugins"] = plugins
if variant == "surgical":
    s["disableBundledSkills"] = True
    s["skillOverrides"] = skills
print(json.dumps(s))
PY
}

for variant in "${variants[@]}"; do
  args=(--dangerously-skip-permissions -p --output-format json --settings "$(settings_for "$variant")")
  [ "$variant" = "today" ] && args+=(--disable-slash-commands)
  for _ in $(seq 1 "$reps"); do
    # The CLI's JSON is passed as an argv value, not piped: this script feeds every python
    # step a heredoc, and a heredoc takes stdin — a pipe here would be swallowed.
    out="$(cd "$REPO" && claude "${args[@]}" "$PROMPT")"
    python3 - "$variant" "$out" <<'PY'
import json, sys
d = json.loads(sys.argv[2])
u = d.get("usage", {})
prefix = sum(u.get(k) or 0 for k in
             ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
print(json.dumps({"variant": sys.argv[1], "prefix": prefix,
                  "cache_creation": u.get("cache_creation_input_tokens"),
                  "cache_read": u.get("cache_read_input_tokens"),
                  "result": str(d.get("result"))[:20]}), flush=True)
PY
  done
done
