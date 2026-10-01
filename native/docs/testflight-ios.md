# iOS TestFlight candidate

`.github/workflows/native-ios-testflight.yml` is dispatched manually. It archives
`run.shepherd.ios` for **Shepherd for Agents** (App Store Connect Apple ID
`6818120191`) and defaults to a **dry run**: a signed App Store IPA artifact retained
for 14 days, with no upload. Signing runs only on the macOS GitHub Actions runner;
never run it against an operator's login keychain.

## Signing configuration

Set repository variable `APPLE_TEAM_ID` (`3WSC8JG6J4`) and these Actions secrets:

- `ASC_API_KEY_P8`: base64 of the App Store Connect team API key's `.p8` file.
- `ASC_KEY_ID`: that key's identifier.
- `ASC_ISSUER_ID`: its issuer identifier.

Use an Admin team API key with access to Certificates, Identifiers & Profiles and
cloud-managed distribution signing. No distribution certificate, P12 password or
manually created provisioning profile is required by this pipeline. Missing inputs
fail closed. The key is decoded into `$RUNNER_TEMP` with mode `0600` and removed by
an `if: always()` step. It is never included in artifacts.

`archive-ios-app.sh` uses `CODE_SIGN_STYLE=Automatic`, the team ID,
`-allowProvisioningUpdates`, `-authenticationKeyPath`, `-authenticationKeyID` and
`-authenticationKeyIssuerID` for archive and export. Xcode manages provisioning;
distribution export uses Apple's cloud-managed signing when no local distribution
identity exists. The archive may use an Apple Development identity before export
re-signs it for distribution. The job summary records the actual identities and
profile names/UUIDs; a successful simulator run proves neither.

Export options use `method=app-store-connect`, `signingStyle=automatic`, the team
ID, `manageAppVersionAndBuildNumber=false`, and `destination=export` for a dry run
or `destination=upload` for a real dispatch. `testFlightInternalTestingOnly=false`
keeps the build eligible for later external testing. These options were verified
against Xcode 27.0's `xcodebuild -help`; see also Apple's
[cloud-managed certificate documentation](https://developer.apple.com/help/account/certificates/cloud-managed-certificates/).

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

gh run list --workflow native-ios-testflight.yml --limit 5
gh run view RUN_ID
```

A new workflow that exists only on a branch may not be dispatchable. For initial
PR verification only, a temporary `pull_request` trigger limited to this workflow
file can run the same job with dry-run forced true. Remove that trigger after
verification; the shipping workflow must be `workflow_dispatch` only.

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

Neither this branch nor the rebased main has a Mac AppIcon asset. The iOS icon uses
the existing brand source `ui/static/icons/v2/icon-maskable.svg`, rasterized with
Sharp at 1024×1024 with the alpha channel removed. This retains the repository's
sheep artwork and full-bleed background; iOS supplies the corner mask. The asset
is `Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.

Keep archives, IPAs, filled export options, signing material and live diagnostics
out of version control. Never upload live-smoke token handoffs or xcresults.
