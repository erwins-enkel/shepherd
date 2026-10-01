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
import json, os, pathlib, shutil, stat, subprocess, sys, tempfile, uuid
key = pathlib.Path(os.environ['ASC_API_KEY_PATH'])
if stat.S_IMODE(key.stat().st_mode) != 0o600:
    sys.exit('API key file must have mode 600')
target = pathlib.Path(sys.argv[1]).resolve()
credentials = ['--key', str(key), '--key-id', os.environ['ASC_KEY_ID'], '--issuer', os.environ['ASC_ISSUER_ID']]
def diagnostics(text):
    for value in (os.environ['ASC_KEY_ID'], os.environ['ASC_ISSUER_ID'], str(key)):
        text = text.replace(value, '[redacted]')
    print(text, file=sys.stderr, flush=True)

# Avoid CalledProcessError: its rendered argv would include credentials.
def run(args):
    result = subprocess.run(args)
    if result.returncode:
        sys.exit('Notarization packaging or stapling failed')
with tempfile.TemporaryDirectory(prefix='notarize-', dir=os.environ['RUNNER_TEMP']) as tmp:
    # A unique server-side name lets us recover this exact submission if a
    # notarytool timeout exits without its promised JSON response.
    suffix = '.zip' if target.suffix == '.app' else '.dmg'
    upload = pathlib.Path(tmp) / f'{target.stem}-{uuid.uuid4()}{suffix}'
    if target.suffix == '.app':
        run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(target), str(upload)])
    else:
        # Submit identical bytes under a unique name; staple the original below.
        shutil.copy2(target, upload)
    # Return before the workflow's 30-minute step timeout so a slow Apple
    # submission still reports its ID/status and attempts to fetch diagnostics.
    result = subprocess.run(['xcrun', 'notarytool', 'submit', str(upload), *credentials,
                             '--wait', '--timeout', '25m', '--output-format', 'json'], capture_output=True, text=True)
    try:
        report = json.loads(result.stdout)
    except ValueError:
        diagnostics(result.stdout + result.stderr)
        history = subprocess.run(['xcrun', 'notarytool', 'history', *credentials,
                                  '--output-format', 'json'], capture_output=True, text=True)
        try:
            matches = [item for item in json.loads(history.stdout)['history'] if item['name'] == upload.name]
        except (ValueError, KeyError, TypeError):
            matches = []
        if history.returncode or len(matches) != 1:
            diagnostics(history.stderr)
            sys.exit('Notarization failed: no unambiguous submission receipt available')
        report = matches[0]
        print('Recovered submission receipt from Apple history', flush=True)
    submission = report.get('id')
    status = report.get('status', 'Unknown')
    summary = f'{target.name}: submission {submission}, status {status}'
    print(summary, flush=True)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write(summary + '\n\n')
    if status != 'Accepted' or not submission:
        if submission:
            # Apple's log contains per-binary diagnostics, not credentials.
            log = subprocess.run(['xcrun', 'notarytool', 'log', submission, *credentials], capture_output=True, text=True)
            diagnostics(log.stdout + log.stderr)
            if log.returncode:
                print('Could not retrieve notarization log', file=sys.stderr)
        sys.exit('Notarization failed: expected Accepted')
    run(['xcrun', 'stapler', 'staple', str(target)])
    run(['xcrun', 'stapler', 'validate', str(target)])
PY
