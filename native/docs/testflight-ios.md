# iOS TestFlight candidate

The archive scripts create and validate local artifacts. They never upload, change
keychains, install signing identities or request provisioning updates.

Copy `native/Apps/ShepherdIOS/ExportOptions.example.plist` outside the repository and
replace the team/profile placeholders. Supply the authorized team, distribution
identity, provisioning profile, path to this file and an explicit export-compliance
answer using `SHEPHERD_IOS_TEAM_ID`, `SHEPHERD_IOS_SIGNING_IDENTITY`,
`SHEPHERD_IOS_PROFILE`, `SHEPHERD_IOS_EXPORT_OPTIONS` and
`SHEPHERD_IOS_EXPORT_COMPLIANCE` (`YES` or `NO`, meaning whether the app uses
non-exempt encryption). Determine that answer for the shipping app; the scripts do
not infer it from simulator success. Missing inputs fail before Xcode runs.

```bash
"$LOCK" native/scripts/archive-ios-app.sh Release
"$LOCK" native/scripts/validate-ios-archive.sh
```

Default artifacts are under `native/Apps/ShepherdIOS/.build/`: `ShepherdIOS.xcarchive`
and `export/`. Existing outputs are refused. Override paths with
`SHEPHERD_IOS_ARCHIVE_PATH` and `SHEPHERD_IOS_EXPORT_PATH`. Validation checks the
archive signature, provisioning presence, `run.shepherd.ios`, version/build, iPhone
and iPad families, export-compliance input, IPA identity and local export method.
It rejects an internal-only distribution setting. This is local validation, not an
App Store Connect acceptance result.

With explicit upload authority, use Xcode Organizer's App Store Connect distribution
flow. Complete App Store Connect privacy, export-compliance and test information,
including contact details and review access. First add an internal group and record
the beta smoke on ordinary iPhone, iPad and the intended Duo surfaces; then prepare
external testers or a public link for explicit publication approval. An internal-only
build cannot become an external beta.
([Apple distribution guidance](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases))

Apple permits up to 100 internal App Store Connect users and 10,000 external testers;
builds expire after 90 days. External testing may require TestFlight App Review.
Record the uploaded build number, expiry, review status and beta results without
Apple account credentials or signing material.
([Apple TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/))

Until signing, simulator/live acceptance, actual archive/export validation and the
authorized TestFlight smoke have run, report those gates as unmet. Keep archives,
IPAs, live result bundles and filled export-options files outside version control.
