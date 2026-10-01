# App updates for Mac testers

Distributed builds use Sparkle 2.10.0 to update **the running Shepherd.app**, independently of
its selected server. The app checks at launch and hourly while running, downloads signed
updates in the background and installs them on quit. Sparkle offers an immediate install and
relaunch through **Shepherd → Check for Updates…**. A running app is not forcibly restarted.
Settings → App updates lets each tester disable automatic checking or installation.

The initial rollout uses one shared tester feed for alpha, beta and subsequent regular releases.
Every build on that feed is offered to every tester; this is not separate stable/beta opt-in.
macOS 15+ is required. Release archives contain both Apple Silicon and Intel executables.

## One-time release setup

1. Obtain Sparkle 2.10.0's tools from the [official release](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.0).
2. Run `bin/generate_keys --account shepherd-mac` on the release maintainer's Mac.
   Keep this key safe: existing installations trust it for all future updates.
3. Set repository variable `SPARKLE_PUBLIC_KEY` to the printed public key.
4. Export the private key with `bin/generate_keys --account shepherd-mac -x /secure/path/key`.
   Set GitHub Actions secret `SPARKLE_PRIVATE_KEY` from this file using `gh secret set
SPARKLE_PRIVATE_KEY < /secure/path/key`. Do not commit it or paste it in logs. Keep a secure backup.
5. Configure the Apple distribution credentials in repository Actions settings:
   - `MACOS_DEVELOPER_ID_P12`: base64 PKCS#12 containing the Developer ID Application certificate and private key.
   - `MACOS_DEVELOPER_ID_P12_PASSWORD`: its export password.
   - `ASC_API_KEY_P8`: base64 App Store Connect team API private key (Admin role).
   - `ASC_KEY_ID` and `ASC_ISSUER_ID`: that API key's identifiers.
   - Repository variable `APPLE_TEAM_ID`: the certificate's Apple Developer team.

   The Account Holder created the Developer ID Application certificate using a certificate
   signing request (CSR), then the certificate and matching private key were exported as the
   password-protected PKCS#12. Keep the originals in secure storage; renew **before September
   2031** and replace the PKCS#12 secrets. Keep the Sparkle key unchanged during renewal.
   The reusable release workflow receives secrets through `secrets: inherit`.

6. Merge the updater and workflow before publishing a release tag containing them.
   The release-please workflow calls `Publish macOS update` after creating a release;
   this also works with GITHUB_TOKEN, whose releases do not trigger other workflows.
   For an already published release, dispatch `Publish macOS update` with its tag.

Until the public variable is set, release-please skips Mac publishing. A manual dispatch fails
with a configuration error rather than producing a build that cannot receive updates.
Local builds without `SHEPHERD_UPDATE_PUBLIC_KEY` and isolated test launches disable the updater.

The pipeline builds from a published tag reachable from main, uses main's first-parent commit
count as CFBundleVersion, and rejects an older build or changed metadata for the current build. Marketing versions
come from the tag. Retries do not increment the build number or replace an existing ZIP.
The DMG, signed update ZIP and its appcast are uploaded to a separate `macos-<source-tag>` draft release, which
is published only after all three assets exist. This works with GitHub immutable releases, including
source releases already published by release-please. Only then is the persistent feed advanced:

`https://raw.githubusercontent.com/erwins-enkel/shepherd/macos-update-feed/appcast.xml`

Do not delete the `macos-update-feed` branch or replace previously published archives.
The branch contains only the appcast, with a commit history for every update. A retry reuses
an already published Mac release and can safely finish a failed feed publication. Never move
release tags. If publication fails after the Mac release is published, rerun the workflow: it
reuses the immutable appcast and advances the feed without rebuilding. The signed package is
also retained as a workflow artifact for 14 days.

## First installation

Download `Shepherd-<build>.dmg` from the [Mac releases](https://github.com/erwins-enkel/shepherd/releases?q=macos-),
open it and drag Shepherd.app onto the Applications shortcut. Open the installed app, then eject
the image. For an installation only for your account, copy it to `~/Applications` instead.

Opening a distributed app directly from Downloads or the disk image offers installation into
`/Applications` or `~/Applications`, after your consent. “Not now” keeps the current app running.
The app copies and verifies its bundle, opens the installed copy and exits the original instance;
the original download is kept. An existing installation is never overwritten: you can open it
(or switch to it if running) and use its updater instead. If copying or launching fails, the
original stays available. Check disk space and write permissions, choose the current-user
installation on the next launch, or copy with Finder. Development and isolated launches skip
this prompt. Subfolders and resolved symbolic links under either Applications folder count
as installed. Read-only DMGs and App Translocation are handled by copying the running bundle,
without modifying or removing its source.

The ZIP is reserved for Sparkle updates; use the DMG for manual installation. Versions shipped before the updater was added need this
one-time replacement. After that, the app uses the feed above. Updating preserves profiles and
credentials stored outside the app bundle. macOS can request authorization if the installation
location is not writable by the current user.

Distributed apps and DMGs are signed with Developer ID, notarized by Apple and stapled.
The workflow imports credentials into a fresh temporary keychain, signs every nested Mach-O
with Hardened Runtime and a secure timestamp, then seals the app without `--deep`.
It follows [Sparkle's helper-signing instructions](https://sparkle-project.org/documentation/sandboxing/),
including preservation of Downloader's entitlements. Existing application entitlements are
preserved. Removing `com.apple.security.cs.disable-library-validation` for distribution only
is a follow-up; local self-signed development builds still need it.

`notarize.sh` submits a temporary app ZIP, requires `Accepted`, and staples and validates the
app. Only then does `package-update.sh` create and EdDSA-sign the update ZIP. The DMG contains
that stapled app and is separately signed, notarized and stapled. CI verifies signatures, the
configured TeamIdentifier and Gatekeeper acceptance for both app and DMG. Key files have
mode 600 under `RUNNER_TEMP`; an always-running cleanup step deletes them and the temporary
keychain and restores the prior user search list. Never use the Developer ID identity locally.

### Continuity from ad-hoc tester builds

Existing testers can update to Developer ID builds while retaining the same Sparkle EdDSA
key. In [Sparkle 2.10.0's SUUpdateValidator](https://github.com/sparkle-project/Sparkle/blob/2.10.0/Sparkle/SUUpdateValidator.m),
`validateDownloadPathWithFallbackOnCodeSigning:` accepts the valid EdDSA archive signature.
With our `SUVerifyUpdateBeforeExtraction` setting, `validateWithUpdateDirectory:` then checks
that the new app has a valid code signature and retains signing and a public update key;
it does not require the previous Apple identity to match. Ad-hoc to Developer ID therefore
passes this policy. This agrees with [Rotating signing keys](https://sparkle-project.org/documentation/#rotating-signing-keys):
change the Apple identity while retaining the EdDSA key. Do not rotate both at once.
The actual two-release installation test below remains necessary for end-to-end acceptance.

### Dry run before publishing

Choose the newest published `v*` source release from `gh release list`, then dispatch the
workflow from the branch containing the signing tooling:

```sh
gh workflow run native-release.yml --ref feat/native-developer-id -f tag=v2.0.0 -f dry_run=true
gh run list --workflow native-release.yml --branch feat/native-developer-id -L 1
```

Poll every two minutes; read failures with `gh run view <id> --log-failed | tail -n 80`.
The app source still comes from the published tag; signing and packaging tools come from
the dispatched ref. `dry_run` skips existing-release reuse, builds/signs/notarizes/staples,
checks Gatekeeper, and uploads the ZIP, DMG and appcast as a 14-day workflow artifact.
It never creates, uploads to or edits a release, or pushes the appcast branch. Notarization
submission IDs/status and Gatekeeper results appear in the job summary. Each submission waits
up to 25 minutes, shorter than the CI step timeout, so a pending Apple response can still be
reported with its submission ID. If the CLI omits JSON on timeout, the script recovers only
its uniquely named upload from Apple's submission history. A timeout fails closed and attempts to retrieve Apple's log;
Apple may continue processing afterward, and no package is published. Manual dispatch
defaults to publication; `workflow_call` retains publication behavior.

Run `native/scripts/test-release-signing.sh` for isolated validation and mocked notarization
checks without signing, accessing a real keychain or making Apple requests.

## Verification before inviting testers

- Build/test with `native/scripts/build-app.sh Release` and
  `native/scripts/test-app.sh -only-testing:ShepherdTests/AppUpdaterTests`.
- Publish a first tagged build with the real public key, install it on a clean test Mac, then
  publish a newer tag. Confirm manual check, automatic download, quit/install/relaunch, and
  unchanged saved profiles. Test both Apple Silicon and Intel before claiming both supported.
- Confirm a current build reports no update, a network failure leaves it usable, and a tampered
  archive is rejected. Verify automatic-check preferences survive restart.
- Test direct launch from Downloads and a read-only DMG, including a quarantined download
  under App Translocation. Exercise both destinations, refusal, an existing stopped/running
  target, missing write permission, and launch failure. Confirm only the installed copy runs
  after success, and that its next launch does not prompt. Keep the source until verified.
- Test app replacement with an actual downloaded bundle in Applications. An isolated test launch
  deliberately cannot update, and a successful compilation alone does not prove replacement.

The implementation follows Sparkle's [setup](https://sparkle-project.org/documentation/) and
[programmatic integration](https://sparkle-project.org/documentation/programmatic-setup/) guides.

## Implementation verification (2026-09-21)

- Xcode 26.6 / Swift 6.3.3: Release build succeeded; executable contains `arm64` and `x86_64`.
- `ShepherdTests/AppUpdaterTests`: four tests passed, including parameterized invalid-key/feed cases.
- Real Ed25519 checks accepted a valid archive and rejected tampering and an unrelated public key.
- A disposable copy of the Release app was packaged with Sparkle's actual tools; its generated
  appcast signature verified against the key embedded in that app.
- EN/DE catalog parity, generated string freshness, workflow YAML/shell syntax and formatting passed.

A production key has since been created in the maintainer's macOS Keychain under account
`shepherd-mac`; repository variable `SPARKLE_PUBLIC_KEY` and Actions secret `SPARKLE_PRIVATE_KEY`
are configured. The public key matches the local signing key; the temporary private-key export
was deleted after upload. That verification did not exercise replacement of an installed app
through the public feed. The two-release test above remains the release acceptance check.

## Installer verification

Run `native/scripts/test-app.sh -only-testing:ShepherdTests/AppInstallationTests
-only-testing:ShepherdTests/AppUpdaterTests` for path recognition, signed copying, collision
protection, failed-copy cleanup and updater eligibility. Run
`native/scripts/test-package-dmg.sh /path/to/Shepherd.app` to create and mount a disposable
read-only DMG and verify its shortcut, EN/DE instructions and copied code signature.

These automated checks do not replace the Finder launch and App Translocation checks above,
or the two-release Sparkle update test. Test those on a clean Mac with the downloaded release.
