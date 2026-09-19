import Foundation
import Testing

@testable import Shepherd

/// Parsing only — `LaunchEnvironment` is deliberately side-effect free, so the
/// switch that keeps automated launches off the Keychain is testable without
/// launching anything.
struct LaunchEnvironmentTests {
    private func configuration(
        arguments: [String] = [], environment: [String: String] = [:]
    ) -> LaunchEnvironment.Configuration {
        LaunchEnvironment.configuration(arguments: arguments, environment: environment)
    }

    @Test func aPlainLaunchIsNotIsolated() {
        let config = configuration(arguments: ["/Applications/Shepherd.app", "-AppleLanguages", "(en)"])
        #expect(config.isIsolated == false)
        #expect(config.live == nil)
        #expect(config.revokesOnExit == false)
        #expect(config.logDescription == "normal launch")
    }

    @Test func theLaunchArgumentIsolates() {
        #expect(configuration(arguments: ["-ShepherdIsolated", "1"]).isIsolated)
        #expect(configuration(arguments: ["-ShepherdIsolated=1"]).isIsolated)
        #expect(configuration(arguments: ["-ShepherdIsolated", "YES"]).isIsolated)
        // A bare flag, with nothing or another flag after it.
        #expect(configuration(arguments: ["-ShepherdIsolated"]).isIsolated)
        #expect(configuration(arguments: ["-ShepherdIsolated", "-AppleLanguages"]).isIsolated)
    }

    @Test func theEnvironmentVariableIsolates() {
        #expect(configuration(environment: ["SHEPHERD_ISOLATED": "1"]).isIsolated)
        #expect(configuration(environment: ["TEST_RUNNER_SHEPHERD_ISOLATED": "1"]).isIsolated)
    }

    @Test func offSpellingsDoNotIsolate() {
        #expect(configuration(arguments: ["-ShepherdIsolated", "0"]).isIsolated == false)
        #expect(configuration(environment: ["SHEPHERD_ISOLATED": "0"]).isIsolated == false)
        #expect(configuration(environment: ["SHEPHERD_ISOLATED": " "]).isIsolated == false)
        // A different flag with a truthy value must not be mistaken for ours.
        #expect(configuration(arguments: ["-ShepherdIsolatedOther", "1"]).isIsolated == false)
    }

    /// The argument is how a UI test overrides a variable the shell exported
    /// for the whole `xcodebuild` run.
    @Test func anExplicitOffArgumentBeatsAnInheritedVariable() {
        let config = configuration(
            arguments: ["-ShepherdIsolated", "0"], environment: ["SHEPHERD_ISOLATED": "1"])
        #expect(config.isIsolated == false)
    }

    @Test func theLiveSeedNeedsBothVariablesAndIsolation() {
        let both = ["SHEPHERD_LIVE_BASE_URL": "https://example.ts.net:7330", "SHEPHERD_LIVE_PASSWORD": "hunter2"]
        #expect(configuration(arguments: ["-ShepherdIsolated", "1"], environment: both).live
            == LaunchEnvironment.LiveSeed(baseURL: "https://example.ts.net:7330", password: "hunter2"))
        // Only the URL.
        #expect(configuration(
            arguments: ["-ShepherdIsolated", "1"],
            environment: ["SHEPHERD_LIVE_BASE_URL": "https://example.ts.net:7330"]).live == nil)
        // The signing-in path mints and revokes real tokens; a launch that is
        // not isolated would do that against the operator's own Keychain.
        #expect(configuration(environment: both).live == nil)
    }

    @Test func liveVariablesAreAlsoReadWithTheTestRunnerPrefix() {
        let config = configuration(
            arguments: ["-ShepherdIsolated", "1"],
            environment: [
                "TEST_RUNNER_SHEPHERD_LIVE_BASE_URL": "https://example.ts.net:7330",
                "TEST_RUNNER_SHEPHERD_LIVE_PASSWORD": "hunter2",
            ])
        #expect(config.live?.baseURL == "https://example.ts.net:7330")
    }

    @Test func revokeOnExitIsOptInAndIsolatedOnly() {
        #expect(configuration(arguments: ["-ShepherdIsolated", "1"]).revokesOnExit == false)
        #expect(configuration(arguments: ["-ShepherdIsolated", "1", "-ShepherdRevokeOnExit", "1"])
            .revokesOnExit)
        #expect(configuration(arguments: ["-ShepherdRevokeOnExit", "1"]).revokesOnExit == false)
    }

    /// The line goes to `os.Logger` at launch. It must say what the mode is and
    /// nothing about what the seed signs in with.
    @Test func theLogLineNamesTheModeAndNoSecrets() {
        let config = configuration(
            arguments: ["-ShepherdIsolated", "1", "-ShepherdRevokeOnExit", "1"],
            environment: [
                "SHEPHERD_LIVE_BASE_URL": "https://example.ts.net:7330",
                "SHEPHERD_LIVE_PASSWORD": "hunter2",
            ])
        let line = config.logDescription
        #expect(line.contains("isolated launch"))
        #expect(line.contains("in-memory credentials"))
        #expect(line.contains("live server seed armed"))
        #expect(line.contains("revoking the minted token on quit"))
        #expect(line.contains("hunter2") == false)
        #expect(line.contains("example.ts.net") == false)
    }
}
