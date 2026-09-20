import AppKit
import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd

private actor SettingsFinalLoginLatch {
    private(set) var waiting = false
    private var continuation: CheckedContinuation<Components.Schemas.AccessTokenList, Never>?
    func read() async -> Components.Schemas.AccessTokenList {
        await withCheckedContinuation { continuation = $0; waiting = true }
    }
    func release() {
        continuation?.resume(returning: .init(tokens: []))
        continuation = nil
    }
}

@Suite(.serialized) @MainActor
struct SettingsFinalTests {
    @Test func profileSwitchDiscardsDelayedSettingsAndTokenLogin() async throws {
        let suite = "SettingsFinal-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        let settingsRead = SettingsReadLatch()
        let retired = SettingsModel(reads: .init(snapshot: { try await settingsRead.read() }))
        app.liveExtensions.append((ObjectIdentifier(SettingsModel.self), retired))
        let pendingRead = Task { await retired.load() }
        while !(await settingsRead.waiting) { await Task.yield() }

        let loginRead = SettingsFinalLoginLatch()
        let tokens = SettingsTokensModel(requests: { _ in
            .init(authenticate: { _ in await loginRead.read() },
                  mint: { _ in throw ShepherdError.notFound }, revoke: { _ in })
        })
        // Exercise the same owner teardown used by SettingsModel, with a held auth completion.
        let profile = try app.addRemoteProfile(name: "fixture", address: "http://127.0.0.1:1")
        let pendingLogin = tokens.authenticate(profile: profile, password: "fixture")
        while !(await loginRead.waiting) { await Task.yield() }
        let generation = app.activationGeneration
        app.register(SettingsModel.self)
        await app.activate(profile)
        #expect(app.activationGeneration != generation)
        let current = try #require(app.extension(SettingsModel.self))
        #expect(current !== retired)
        tokens.close() // Access pane closes on activation change and disappearance.
        await settingsRead.fail()
        await loginRead.release()
        await pendingRead.value
        await pendingLogin?.value
        #expect(retired.snapshot == nil)
        #expect(retired.error == nil)
        #expect(!tokens.authenticated)
        #expect(tokens.revealed == nil)
        #expect(tokens.entries.isEmpty)
        #expect(tokens.error == nil)
        app.teardown()
        #expect(app.extension(SettingsModel.self) == nil)
    }

    @Test func activationTeardownClearsAnAlreadyRevealedToken() async throws {
        let suite = "SettingsFinalSecret-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        let server = SettingsFakeServer()
        defer { server.tearDown() }
        server.on("POST", "/api/login") { _ in
            SettingsFakeResponse(headers: ["Content-Type": "application/json",
                "Set-Cookie": "shepherd_session=fixture; Path=/; HttpOnly"], body: Data(#"{"ok":true}"#.utf8))
        }
        server.stub("GET", "/api/access-tokens", status: 200, json: Data(#"{"tokens":[]}"#.utf8))
        server.stub("POST", "/api/access-tokens", status: 201, json: Data(#"{"token":"shp_fixture_new1","entry":{"id":"fixture","name":"fixture","hint":"cret","scope":"read","createdAt":1,"expiresAt":null,"lastUsedAt":null}}"#.utf8))
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
        app.liveExtensions.append((ObjectIdentifier(SettingsModel.self), model))
        let profile = ServerProfile(name: "fixture", baseURL: server.baseURL, mode: .local)
        await model.tokens.authenticate(profile: profile, password: "fixture", session: server.urlSession())?.value
        try #require(model.tokens.authenticated)
        await model.tokens.mint(name: "fixture", days: nil, scope: .read)?.value
        #expect(model.tokens.revealed != nil)
        app.teardown()
        #expect(model.tokens.revealed == nil)
        #expect(!model.tokens.authenticated)
        #expect(model.tokens.entries.isEmpty)
    }

    private final class AppearanceValues {
        var scheme: ColorScheme?
        var motion: Bool?
        var systemMotion = false
        var animationsDisabled = false
    }
    private struct AppearanceProbe: View {
        let values: AppearanceValues
        @State private var changed = false
        @Environment(\.colorScheme) private var scheme
        @Environment(\.shepherdReduceMotion) private var motion
        @Environment(\.accessibilityReduceMotion) private var systemMotion
        var body: some View {
            Color.clear.frame(width: 80, height: 80).opacity(changed ? 1 : 0.9)
                .onAppear {
                    values.scheme = scheme; values.motion = motion; values.systemMotion = systemMotion
                    withAnimation { changed = true }
                }
                .onChange(of: scheme) { values.scheme = scheme }
                .transaction { if $0.disablesAnimations { values.animationsDisabled = true } }
        }
    }

    @Test(arguments: ["system", "light", "dark"], ["system", "full", "reduced"])
    func appearanceAppliesInBothSceneHosts(theme: String, motion: String) async throws {
        let suite = "SettingsFinalAppearance-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(theme, forKey: "native.appearance.theme")
        defaults.set(motion, forKey: "native.appearance.motion")
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        for hostsPalette in [true, false] {
            let values = AppearanceValues()
            let content = AppearanceProbe(values: values)
                .modifier(SettingsRootModifier(app: app, hostsPalette: hostsPalette))
                .defaultAppStorage(defaults)
            let host = NSHostingView(rootView: content)
            let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 100, height: 100),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            window.orderFront(nil)
            defer { window.orderOut(nil); window.contentView = nil }
            host.layoutSubtreeIfNeeded()
            let deadline = ContinuousClock.now + .seconds(2)
            while (values.motion == nil || (motion == "reduced" && !values.animationsDisabled)), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(values.motion == (motion == "system" ? values.systemMotion : motion == "reduced"))
            if theme == "dark" { #expect(values.scheme == .dark) }
            if theme == "light" { #expect(values.scheme == .light) }
            if theme == "system" {
                let systemDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                #expect(values.scheme == (systemDark ? .dark : .light))
            }
            if motion == "reduced" || (motion == "system" && values.systemMotion) {
                #expect(values.animationsDisabled)
            }
        }
    }
}
