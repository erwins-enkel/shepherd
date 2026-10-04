# iOS TestFlight candidate

`.github/workflows/native-ios-testflight.yml` runs nightly at 04:00 UTC on `main` (a real upload,
`dry_run` forced off) when `native/**`, `contracts/**` or the workflow itself changed since the last
upload, after an app-relevant merge when no upload happened for 24 hours, and can also be
dispatched manually. It archives
`run.shepherd.ios` for **Shepherd for Agents** (App Store Connect Apple ID
`6818120191`) and defaults to a **dry run**: a signed App Store IPA artifact retained
for 14 days, with no upload. Signing runs only on the macOS GitHub Actions runner;
never run it against an operator's login keychain.

## Signing configuration

Set repository variable `APPLE_TEAM_ID` (`3WSC8JG6J4`) and these Actions secrets:

- `IOS_DISTRIBUTION_P12`: base64 of a `.p12` containing exactly one Apple
  Distribution certificate and its private key.
- `IOS_DISTRIBUTION_P12_PASSWORD`: the password protecting that `.p12`.
- `IOS_APPSTORE_PROFILE`: base64 of the App Store `.mobileprovision` for
  `3WSC8JG6J4.run.shepherd.ios`, containing that distribution certificate.
- `ASC_API_KEY_P8`: base64 of the Admin App Store Connect team API key's `.p8` file.
- `ASC_KEY_ID`: that key's identifier.
- `ASC_ISSUER_ID`: its issuer identifier.

Missing inputs fail closed, including the upload credentials on dry runs. The
workflow decodes signing material with mode `0600`, creates a temporary keychain
with a random masked password, unlocks it with a six-hour timeout and grants
`apple-tool:,apple:,codesign:` access to the imported private key. It adds this
keychain to the user search list without changing or importing into the login or
default keychain. It reads the profile UUID using `security cms -D` and `plutil`,
checks the team, app ID, expiry and matching certificate, and installs it under
`~/Library/MobileDevice/Provisioning Profiles/<UUID>.mobileprovision`.
An `if: always()` step restores the original search list and removes the temporary
keychain, installed profile, P12, API key and decoded metadata. Artifacts contain
only the dry-run IPA.

`archive-ios-app.sh` generates from `project-app-store.yml`, which includes the
ordinary project spec and sets **only the ShepherdIOS app target's Release
configuration** to `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY=Apple Distribution`,
`PROVISIONING_PROFILE_SPECIFIER=<decoded UUID>` and `DEVELOPMENT_TEAM=$APPLE_TEAM_ID`.
It enables signing only for that app. The script verifies that the scheme archives
only `ShepherdIOS`; the unit/UI test bundles remain unsigned and test-only. Archive
and export use neither `-allowProvisioningUpdates` nor API authentication flags.
No development profile or registered device is needed for TestFlight. Device
registration is needed when installing and running directly from Xcode on a phone.

Export options use `method=app-store-connect`, `signingStyle=manual`, `teamID`,
`signingCertificate=Apple Distribution`, and
`provisioningProfiles={run.shepherd.ios: <decoded UUID>}`. Both dispatch modes use
`destination=export` and validate the signed IPA before any upload.
`manageAppVersionAndBuildNumber=false` preserves the selected version/build;
`testFlightInternalTestingOnly=false` keeps later external testing possible.
For `dry_run=false` only, the script then invokes `xcrun altool --upload-app -f
<IPA> -t ios --apiKey <key ID> --apiIssuer <issuer ID>`, with
`API_PRIVATE_KEYS_DIR` pointing to the temporary `AuthKey_<key ID>.p8` directory.
The API key is used only for this upload. Apple currently supports altool uploads
for iOS apps built using Xcode 26 or later; see
[Apple's upload documentation](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).
`notarytool` serves notarization and is not the iOS App Store upload path. The runner
reports its actual Xcode version; the job summary records the archive/export
identity and profile name/UUID. A simulator run proves neither.

### Renewal before 2027-10-01

The current identity is **Apple Distribution: Erwins Enkel GmbH (3WSC8JG6J4)**;
the profile is **Shepherd iOS App Store**, UUID
`51ef1ac8-764b-4bc0-b647-68cb7a0d7e8d`. Both expire on **2027-10-01**.
Renew both before that date and run another dry run. Generate a new private key
and CSR, create an `IOS_DISTRIBUTION` certificate using the Admin API key, export
that certificate plus its private key into a password-protected P12, then create
an `IOS_APP_STORE` profile for the app ID with the new certificate. Replace all
three signing secrets together. The API creates the certificate/profile; keep the
new private key securely, since it cannot be recovered from the certificate.
The workflow derives the replacement UUID automatically. See Apple's
[certificate API](https://developer.apple.com/documentation/appstoreconnectapi/certificates)
and [profile API](https://developer.apple.com/documentation/appstoreconnectapi/profiles).

The build number is `git rev-list --first-parent --count origin/main`, using the
same counting rule as `native-release.yml`, even for a feature-branch dry run.
The marketing version is the highest version-sorted `v*` tag, or `0.1.0` when no
such tag exists. SemVer prerelease/build suffixes are omitted for Apple’s numeric
marketing-version field (for example, `v2.0.0-beta.1` becomes `2.0.0`). Other
non-numeric versions fail before archive. Repeated runs
on the same main revision keep the same build number: after uploading it, advance
main before another upload of that marketing version.

## Dispatch and review

After the workflow exists on the default branch:

```bash
gh workflow run native-ios-testflight.yml \
  --ref codex/2431-ios-stage-2 \
  -f ref=codex/2431-ios-stage-2 -f dry_run=true

gh api repos/erwins-enkel/shepherd/actions/runs/RUN_ID
```

The existing workflow also accepts a branch dispatch for PR verification; use
`--ref` and input `ref` together as above. Keep the shipping workflow
`workflow_dispatch` only. Poll at most once every three minutes with one combined
REST request per poll, never `--watch`; cap verification at six dry-run attempts.
If GitHub reports a rate limit, read `gh api rate_limit` and wait until its reset.

Download the `shepherd-ios-BUILD_NUMBER` artifact and inspect the run summary.
`validate-ios-archive.sh` verifies the signature, provisioning team and app ID,
expiry, iPhone/iPad families, display name, app icon, encryption declaration and
archive/IPA metadata agreement. Exported profiles must be App Store distribution
profiles, with no device list or debugging entitlement. A dry run does not prove
App Store Connect upload acceptance or beta availability.

Only after review and merge, the release operator can explicitly upload:

```bash
gh workflow run native-ios-testflight.yml --ref main -f ref=main -f dry_run=false
```

This task must not execute that upload command. After an authorized upload, wait
for processing under App Store Connect → Shepherd for Agents → TestFlight.
Complete beta information, contact details, privacy and review access. Create an
**internal testing group**, add the processed build and authorized App Store
Connect users, then record beta smoke results on iPhone and iPad. Hardware/Duo and
live-server acceptance remain separate gates. External groups/public links and
TestFlight App Review are subsequent publication steps.

Builds expire **90 days** after upload. Record the build number, expiry, processing
and review status and smoke results. See Apple's
[internal tester instructions](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
and [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

## Encryption and icon provenance

The iOS app and shared `ShepherdAppCore`/`ShepherdKit` sources contain no CryptoKit,
CommonCrypto, custom cipher or encryption implementation; networking uses the OS
URLSession HTTP(S)/TLS stack. OS Keychain storage does not implement custom
cryptography. `ITSAppUsesNonExemptEncryption=false` is set both in the source plist
and XcodeGen properties. Reassess this declaration if encryption dependencies or
features change. `CFBundleDisplayName` is `Shepherd`.

Both apps use the existing brand artwork. The Mac target compiles
`native/Apps/ShepherdMac/Sources/AppIcon.icon` with a dark background and a separate
sheep layer; Xcode supplies the macOS shape and the macOS 15 fallback. The iOS icon uses
the existing brand source `ui/static/icons/v2/icon-maskable.svg`, rasterized with
Sharp at 1024×1024 with the alpha channel removed. This retains the repository's
sheep artwork and full-bleed background; iOS supplies the corner mask. The asset
is `Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.

Keep archives, IPAs, filled export options, signing material and live diagnostics
out of version control. Never upload live-smoke token handoffs or xcresults.

## Automatic uploads and previews

Each night at 04:00 UTC (06:00 Berlin in summer, 05:00 in winter) the workflow ships `main` to the
internal TestFlight group ("Enkel", access to all builds), but only if the app changed since the last
upload: a gate job compares `main` with the head of the last successful run named `upload …` (or an
older per-merge push run) and skips the archive when nothing under `native/`, `contracts/` or the
workflow changed. As a fallback while GitHub's scheduled runs are unreliable, an app-relevant
merge to `main` runs the same gate and uploads only when the last real upload is more than 24 hours
old, so there is at most one automatic build a day. The gate counts a run as an upload only if its
archive job succeeded (a gated-off nightly also concludes "success"). For a build right after a
merge, dispatch it manually (`-f dry_run=false`). Its build number is main's first-parent commit count. A manual
dispatch of any other ref (a feature branch preview) uploads `<count>.<run number>` instead, so a
preview never takes the number the next main build needs. Concurrent runs queue rather than cancel.
