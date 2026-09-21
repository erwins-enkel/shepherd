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
5. Merge the updater and workflow before publishing a release tag containing them.
   The release-please workflow calls `Publish macOS update` after creating a release;
   this also works with GITHUB_TOKEN, whose releases do not trigger other workflows.
   For an already published release, dispatch `Publish macOS update` with its tag.

Until the public variable is set, release-please skips Mac publishing. A manual dispatch fails
with a configuration error rather than producing a build that cannot receive updates.
Local builds without `SHEPHERD_UPDATE_PUBLIC_KEY` and isolated test launches disable the updater.

The pipeline builds from a published tag reachable from main, uses main's first-parent commit
count as CFBundleVersion, and rejects an older build or changed metadata for the current build. Marketing versions
come from the tag. Retries do not increment the build number or replace an existing ZIP.
The ZIP and its appcast are uploaded to a separate `macos-<source-tag>` draft release, which
is published only after both assets exist. This works with GitHub immutable releases, including
source releases already published by release-please. Only then is the persistent feed advanced:

`https://raw.githubusercontent.com/erwins-enkel/shepherd/macos-update-feed/appcast.xml`

Do not delete the `macos-update-feed` branch or replace previously published archives.
The branch contains only the appcast, with a commit history for every update. A retry reuses
an already published Mac release and can safely finish a failed feed publication. Never move
release tags. If publication fails after the Mac release is published, rerun the workflow: it
reuses the immutable appcast and advances the feed without rebuilding. The signed package is
also retained as a workflow artifact for 14 days.

## First installation

Download `Shepherd-<build>.zip` from the release, unzip and move Shepherd.app to `/Applications`
(or `~/Applications`) before opening. Versions shipped before the updater was added need this
one-time replacement. After that, the app uses the feed above. Updating preserves profiles and
credentials stored outside the app bundle. macOS can request authorization if the installation
location is not writable by the current user.

The current pipeline retains the project's **ad-hoc signing** for early testers. Sparkle's Ed25519
signatures authenticate update archives, but do not provide Apple Developer ID or notarization.
Gatekeeper can therefore still block the initial downloaded app. Developer ID/notarization is a
separate distribution prerequisite for a frictionless public download and is not claimed here.

## Verification before inviting testers

- Build/test with `native/scripts/build-app.sh Release` and
  `native/scripts/test-app.sh -only-testing:ShepherdTests/AppUpdaterTests`.
- Publish a first tagged build with the real public key, install it on a clean test Mac, then
  publish a newer tag. Confirm manual check, automatic download, quit/install/relaunch, and
  unchanged saved profiles. Test both Apple Silicon and Intel before claiming both supported.
- Confirm a current build reports no update, a network failure leaves it usable, and a tampered
  archive is rejected. Verify automatic-check preferences survive restart.
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
was deleted after upload. No release has been published and
replacement of an installed app through the public feed has not yet been exercised. The
two-release test above remains the release acceptance check after merging and publishing the updater.
