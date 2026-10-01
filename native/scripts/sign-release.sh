#!/usr/bin/env bash
# CI only. Sign nested code inside-out, then seal the app; never sign with --deep.
# Usage: sign-release.sh /path/Shepherd.app 'Developer ID Application: …' /tmp/keychain
set -euo pipefail
[[ $# == 3 ]] || { echo 'Usage: sign-release.sh <app> <Developer ID identity> <keychain>' >&2; exit 1; }
[[ -d "$1" && "$1" == *.app && -f "$1/Contents/Info.plist" ]] || { echo 'Expected an app bundle' >&2; exit 1; }
[[ "$2" == 'Developer ID Application: '* ]] || { echo 'Expected a Developer ID Application identity' >&2; exit 1; }
[[ -f "$3" ]] || { echo 'Expected an existing temporary keychain' >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" && "$3" == "$RUNNER_TEMP/"* ]] || {
  echo 'Release signing requires GitHub Actions and a keychain under RUNNER_TEMP' >&2; exit 1;
}
[[ -n "${APPLE_TEAM_ID:-}" ]] || { echo 'Set APPLE_TEAM_ID' >&2; exit 1; }
python3 - "$@" <<'PY'
import os, pathlib, plistlib, subprocess, sys
app, identity, keychain = sys.argv[1:]
app = pathlib.Path(app)
def run(args):
    subprocess.run(args, check=True)

# Do not follow framework aliases: sign each physical Mach-O and bundle once.
# Sparkle 2.10 instructions: https://sparkle-project.org/documentation/sandboxing/
# Installer, Autoupdate and Updater get fresh entitlements; Downloader retains
# its distributed entitlements (required since Sparkle 2.6).
paths = []
for root, dirs, files in os.walk(app, followlinks=False):
    dirs[:] = [d for d in dirs if not (pathlib.Path(root) / d).is_symlink()]
    for name in files:
        path = pathlib.Path(root) / name
        if not path.is_symlink() and 'Mach-O' in subprocess.check_output(['file', '-b', str(path)], text=True):
            paths.append(path)
    path = pathlib.Path(root)
    if path.suffix in ('.app', '.xpc', '.framework', '.appex', '.bundle'):
        # Resource-only bundles have no code to sign.
        info = path / ('Resources/Info.plist' if path.suffix == '.framework' else 'Contents/Info.plist')
        if info.is_file() and plistlib.loads(info.read_bytes()).get('CFBundleExecutable'):
            paths.append(path)
paths.sort(key=lambda p: len(p.parts), reverse=True)
for path in paths:
    relative = str(path.relative_to(app))
    sparkle = '/Sparkle.framework/Versions/' in '/' + relative
    fresh = sparkle and ('/Updater.app' in relative or '/Installer.xpc' in relative or relative.endswith('/Autoupdate'))
    command = ['codesign', '--force', '--sign', identity, '--keychain', keychain,
               '--options', 'runtime', '--timestamp']
    if not fresh:
        command += ['--preserve-metadata=entitlements']
    run(command + [str(path)])

# Verify every architecture of every nested executable, not just the outer seal.
for path in paths:
    run(['codesign', '--verify', '--strict', '--all-architectures', str(path)])
    for arch in ('arm64', 'x86_64'):
        details = subprocess.check_output(['codesign', '-d', '--verbose=4', '--arch', arch, str(path)], stderr=subprocess.STDOUT, text=True)
        assert 'TeamIdentifier=' + os.environ['APPLE_TEAM_ID'] in details, f'Wrong team: {path}'
        assert 'runtime' in details and 'Timestamp=' in details, f'Missing runtime or secure timestamp: {path}'
run(['codesign', '--verify', '--deep', '--strict', str(app)])
PY
