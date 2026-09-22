import AppKit
import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

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

extension MacSeamTests {
@Suite(.serialized) @MainActor
struct SettingsFinalTests {

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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
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
}
