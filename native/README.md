# Shepherd for Mac

The macOS app under `Apps/ShepherdMac`, built on the `ShepherdKit` package in this directory.
The Xcode project is **generated** from `Apps/ShepherdMac/project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen) — never edit `Shepherd.xcodeproj`, it is
gitignored.

## Prerequisites

- Xcode 26.6 or newer (`xcodebuild -version`)
- `brew install xcodegen`

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

Runs the Swift Testing unit bundle (`ShepherdTests`) and the XCUITest smoke
bundle (`ShepherdUITests`). Add `-only-testing:ShepherdTests` to skip the UI
test, which needs a logged-in GUI session.

## Localisation

EN and DE only, mirrored from the web catalogs. Add or change copy in
`ui/messages/en.json` **and** `ui/messages/de.json` first, then regenerate:

```
native/scripts/gen-strings.sh
```

`native/scripts/gen-strings.sh --check` fails if the committed catalog is stale;
CI runs exactly that.

## Signing

Ad-hoc (`CODE_SIGN_IDENTITY: "-"`), App Sandbox off, Hardened Runtime on.
Developer ID and notarisation are a later sub-project — switching is a
`project.yml` edit, not a refactor.
