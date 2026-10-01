# Shepherd for iOS

The iOS 18 application uses `ShepherdAppCore` and `ShepherdKit`. It registers only
`SidebarModel` and `DetailModel`. Profiles, login, activation generations and the
single event connection remain owned by `AppModel`. The app presents session
metadata and activity; terminal, composition, merge and session mutation are outside
this stage.

## Local simulator workflow

Install the repository's Swift 6.2+ Xcode toolchain and XcodeGen 2.46+. From the
repository root, wrap each entire script once. Scripts never acquire another lock.

```bash
LOCK=/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/uitest-lock.sh
"$LOCK" native/scripts/build-ios-app.sh Debug
"$LOCK" native/scripts/test-ios-app.sh unit
"$LOCK" native/scripts/test-ios-app.sh ui --family iPhone
"$LOCK" native/scripts/test-ios-app.sh ui --family iPad
```

CI uses `native/scripts/uitest-lock.sh`. Tests select available iOS 18+ devices by
numeric runtime version, then name and UDID. The family selector refuses to replace
an unavailable family with another. A missing toolchain/device is an unmet gate.
`--result-bundle-path` accepts a fresh absolute path. The test script retains the
xcresult plus summary/tests JSON and requires every discovered test identity to
execute successfully; zero tests, missing cases, skips and malformed results fail.
Keep one top-level nonparameterized test suite per test source; changes to this
convention require an explicit expected inventory and validator coverage.

Automated launches pass `-ShepherdIsolated 1` and use private defaults and memory
credentials. Unit runners also receive both isolation environment spellings.
Neither local nor simulator CI enables Keychain tests. Native tests remain serialized
across worktrees; Mac authorization dialogs belong to #2434.

## Lifecycle and recovery

Temporary inactivity forwards presence through `SessionStore.setActive(false)`;
it does not stop and restart the store. Foreground entry refreshes session state and
visible activity. Current-store transitions to `.live` trigger another visible
activity refresh so a failed earlier attempt cannot leave the screen stale. No
background execution or timer is promised. Profile changes replace the activation
and invalidate old selections and detail tasks.

## Live acceptance

Only `native/scripts/live-ios-smoke.sh --config
~/.config/shepherd/codex/live-smoke.json`, wrapped in the same native lock, may read
the operator-supplied live configuration. The harness accepts the existing
`base_url`/`operator_password` fields (and the equivalent `baseURL`/`password`
spellings); the file must be owned by the current user and have mode `0600`.
Ordinary CI never reads it. The live
harness owns one uniquely named token, records ownership before activation, performs
audited reads and verifies that the exact token receives HTTP 401 after revocation.
An empty server cannot pass the detail gate. Missing cleanup proof fails the run.
Do not print secrets, put them on command lines, upload live xcresults, or sweep
tokens by a shared name. Production sign-out only confirms local removal because
the current logout API does not reliably report remote revocation.

The harness creates a private `0700` run directory. The isolated app atomically
writes a `0600` handoff containing `runID`, `tokenID`, `token` and `baseURL` before
activation; UI/status records contain no token. The verifier checks run and origin
ownership, rejects redirects, revokes only that ID, then probes the authenticated
sessions route. Verified cleanup deletes the token handoff. Unverified cleanup
retains private evidence and reports an unmet gate with the nonsecret run ID.
Never publish those private diagnostics or xcresults as CI artifacts.

## Adaptive and Duo validation

The ordinary iPhone/iPad lanes verify the deployment-floor layout. Apple documents
the iPhone Duo simulator in Xcode 27.1 and Reserved Region APIs in iOS 27.1.
([Apple preparation guidance](https://developer.apple.com/videos/play/tech-talks/111461/))
The separate `DuoOuter` and `DuoInner` selectors require explicitly available
surface destinations. If installed simulator metadata does not expose them, the
lane fails as unmet; a generic iPhone run is not Duo evidence. DeviceHub surface
configuration and hardware keyboard/hinge validation must be recorded separately.
Preserve the size-class fallback on iOS 18.

Release distribution has separate signing inputs and gates; see
[TestFlight preparation](testflight-ios.md). No simulator test implies a signed
archive, tested hardware, uploaded build or approved external beta.
