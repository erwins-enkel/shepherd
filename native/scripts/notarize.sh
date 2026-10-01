#!/usr/bin/env bash
# Submit an app (via a temporary ZIP) or DMG, then staple the original target.
# Credentials are supplied only through env; no secret values are traced.
{ set +x; } 2>/dev/null
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: notarize.sh <app-or-dmg>' >&2; exit 1; }
[[ ( -d "$1" && "$1" == *.app ) || ( -f "$1" && "$1" == *.dmg ) ]] || {
  echo 'Expected an existing app bundle or DMG' >&2; exit 1;
}
for name in ASC_API_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID RUNNER_TEMP; do
  [[ -n "${!name:-}" ]] || { echo "Set $name" >&2; exit 1; }
done
[[ -f "$ASC_API_KEY_PATH" && "$ASC_API_KEY_PATH" == "$RUNNER_TEMP/"* ]] || {
  echo 'Expected an API key file under RUNNER_TEMP' >&2; exit 1;
}
python3 - "$1" <<'PY'
import json, os, pathlib, stat, subprocess, sys, tempfile
key = pathlib.Path(os.environ['ASC_API_KEY_PATH'])
if stat.S_IMODE(key.stat().st_mode) != 0o600:
    sys.exit('API key file must have mode 600')
target = pathlib.Path(sys.argv[1]).resolve()
credentials = ['--key', str(key), '--key-id', os.environ['ASC_KEY_ID'], '--issuer', os.environ['ASC_ISSUER_ID']]
# Avoid CalledProcessError: its rendered argv would include credentials.
def run(args):
    result = subprocess.run(args)
    if result.returncode:
        sys.exit('Notarization packaging or stapling failed')
with tempfile.TemporaryDirectory(prefix='notarize-', dir=os.environ['RUNNER_TEMP']) as tmp:
    upload = target
    if target.suffix == '.app':
        upload = pathlib.Path(tmp) / 'submission.zip'
        run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(target), str(upload)])
    result = subprocess.run(['xcrun', 'notarytool', 'submit', str(upload), *credentials,
                             '--wait', '--output-format', 'json'], capture_output=True, text=True)
    try:
        report = json.loads(result.stdout)
    except ValueError:
        sys.exit('notarytool submit failed without a JSON response; check credentials and connectivity')
    submission = report.get('id')
    status = report.get('status', 'Unknown')
    summary = f'{target.name}: submission {submission}, status {status}'
    print(summary, flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write(summary + '\n\n')
    if result.returncode or status != 'Accepted' or not submission:
        if submission:
            # Apple's log contains per-binary diagnostics, not credentials.
            log = subprocess.run(['xcrun', 'notarytool', 'log', submission, *credentials], capture_output=True, text=True)
            print(log.stdout, flush=True)
            if log.returncode:
                print('Could not retrieve notarization log', file=sys.stderr)
        sys.exit('Notarization failed: expected Accepted')
    run(['xcrun', 'stapler', 'staple', str(target)])
    run(['xcrun', 'stapler', 'validate', str(target)])
PY
