import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@Suite(.serialized) @MainActor struct LocalServerModelTests {
    private func tempHome() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("s5-app-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func checkout(in home: URL) throws -> LocalServerEnvironment {
        let environment = LocalServerEnvironment(home: home)
        try FileManager.default.createDirectory(
            at: environment.appDirectory, withIntermediateDirectories: true)
        try #"{"name":"shepherd"}"#.write(
            to: environment.appDirectory.appendingPathComponent("package.json"),
            atomically: true, encoding: .utf8)
        return environment
    }

    /// `AppModel` takes `defaults:` + `credentials:`, not a built `ProfileStore`
    /// — a private suite keeps this test off the operator's real defaults, and
    /// the in-memory credential store keeps it out of the Keychain.
    private func freshApp() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func aMissingCheckoutReadsAsNotInstalled() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { false })
        await model.refresh()
        #expect(model.state == .notInstalled)
        #expect(model.canInstall)
    }

    @Test func aCheckoutWithNoRunningServerReadsAsStopped() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(environment: try checkout(in: home), probeExternal: { false })
        await model.refresh()
        #expect(model.state == .stopped)
        #expect(model.canStart)
    }

    /// A server we did not start must never be stoppable from this panel.
    @Test func somethingAlreadyOnPort7330IsExternallyManaged() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { true })
        await model.refresh()
        #expect(model.state == .externallyManaged)
        #expect(model.canStop == false)
    }

    @Test func everyStateHasACatalogSentence() {
        let states: [LocalServerState] = [
            .notInstalled, .installing, .stopped, .starting, .running(pid: 42), .externallyManaged,
            .failed(.bunMissing), .failed(.notAShepherdCheckout(path: "/tmp/x")),
            .failed(.installFailed(exitCode: 3)), .failed(.exited(code: 1)),
            .failed(.crashLoop(restarts: 3)), .failed(.healthTimeout),
        ]
        for state in states {
            let text = LocalServerCopy.label(for: state)
            #expect(!text.isEmpty)
            #expect(text.hasPrefix("native_local_") == false)  // a leaked key = missing catalog entry
        }
    }

    /// Offered once, then dropped — never written anywhere that outlives the panel.
    @Test func connectingHandsThePasswordToTheLoginSheetExactlyOnce() async throws {
        let home = try tempHome(); defer { try? FileManager.default.removeItem(at: home) }
        let app = freshApp()
        let model = LocalServerModel(
            environment: LocalServerEnvironment(home: home), probeExternal: { false })
        model.capturedPassword = "Zx9_test-password-abcdefgh"

        model.connect(app)
        #expect(app.sheet == .login(app.addLocalProfile()))
        #expect(model.capturedPassword == nil)
        #expect(model.takePendingPassword() == "Zx9_test-password-abcdefgh")
        #expect(model.takePendingPassword() == nil)
    }

    @Test func installingTheFeatureFillsTheWelcomeSlotAndIsIdempotent() {
        WelcomeSlots.localPanel = nil
        LocalServerFeature.install()
        #expect(WelcomeSlots.localPanel != nil)
        LocalServerFeature.install()
        #expect(WelcomeSlots.localPanel != nil)
        WelcomeSlots.reset()
    }
}
