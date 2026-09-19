# Shepherd for Mac

The macOS app under `Apps/ShepherdMac`, built on the `ShepherdKit` package in this directory.
The Xcode project is **generated** from `Apps/ShepherdMac/project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen) — never edit `Shepherd.xcodeproj`, it is
gitignored.

## Prerequisites

- Xcode 26.6 or newer (`xcodebuild -version`)
- `brew install xcodegen`
- [`bun`](https://bun.sh) (generates the string catalog and runs the sync/contract scripts)

## Build

```
native/scripts/build-app.sh Release
```

Produces `native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app`.

## Run

```
open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
```

## Test

```
native/scripts/test-app.sh
```

Runs the Swift Testing unit bundle (`ShepherdTests`). The scheme also builds
and runs the `ShepherdUITests` XCUITest bundle, but that bundle has no source
files until Task 11 adds a smoke test, so xcodebuild cannot find its compiled
executable and the bare invocation above currently fails at the test step
(the build itself succeeds). Pass `-only-testing:ShepherdTests` to scope the
run to the unit bundle, which is what CI does:

```
native/scripts/test-app.sh -only-testing:ShepherdTests
```

## Localisation

EN and DE only, mirrored from the web catalogs. Add or change copy in
`ui/messages/en.json` **and** `ui/messages/de.json` first, then regenerate:

```
native/scripts/gen-strings.sh
```

`bun native/scripts/gen-strings.ts --check` fails if the committed catalog is
stale; CI runs that via `bun run check:strings`.

## Signing

Ad-hoc (`CODE_SIGN_IDENTITY: "-"`), App Sandbox off, Hardened Runtime on.
Developer ID and notarisation are a later sub-project — switching is a
`project.yml` edit, not a refactor.
