import AppKit
import ApplicationServices
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
    @MainActor @Suite(.serialized) struct ComposeRecoveryTests {
        private struct Element {
            let id: String
            let text: String
            let object: AnyObject
        }

        private func rendered<V: View>(_ view: V, check: ([Element]) throws -> Void) async throws {
            let host = NSHostingView(rootView: view)
            let window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: 1040, height: 780),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.contentView = host
            window.orderFront(nil)
            host.layoutSubtreeIfNeeded()
            defer { window.orderOut(nil); window.contentView = nil }
            let pid = ProcessInfo.processInfo.processIdentifier
            let status = await Task.detached {
                let application = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(application, 0.25)
                var windows: CFTypeRef?
                return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows).rawValue
            }.value
            #expect(status == AXError.success.rawValue)
            func walk(_ object: Any, depth: Int = 0) -> [Element] {
                guard depth < 60 else { return [] }
                let element = object as AnyObject
                let value: Any? = element.accessibilityValue?()
                return [Element(id: element.accessibilityIdentifier?() ?? "",
                                text: [element.accessibilityLabel?(), value as? String].compactMap { $0 }.joined(separator: " "),
                                object: element)]
                    + (element.accessibilityChildren?() ?? []).flatMap { walk($0, depth: depth + 1) }
            }
            try check(walk(host))
        }

        @Test func credentialFailureHasUsableRetryInsideCompose() async throws {
            let suite = "ComposeRecovery.\(UUID())"
            let defaults = try #require(UserDefaults(suiteName: suite))
            let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
                               notifications: MacTestSupport.environment(defaults: defaults))
            defer { app.teardown(); defaults.removePersistentDomain(forName: suite) }
            let a = try app.addRemoteProfile(name: "A", address: "https://a.fixture.invalid")
            let b = try app.addRemoteProfile(name: "B", address: "https://b.fixture.invalid")
            app.health = { _ in throw ShepherdError.transport("fixture") }
            app.credentialProbe = { _, _ in StoredCredential(token: "fixture", tokenId: "fixture") }
            await app.activate(a); app.sheet = .newSession
            app.credentialProbe = { _, _ in throw ShepherdError.transport("fixture") }
            await app.activateForCompose(b, prompt: "Keep my prompt")
            app.credentialProbe = { _, _ in StoredCredential(token: "fixture", tokenId: "fixture") }
            try await rendered(ComposeSheet().environment(app)) { elements in
                let retry = try #require(elements.first { $0.id == "compose.retryCredentials" })
                #expect(retry.object.accessibilityPerformPress?() == true)
            }
            let deadline = ContinuousClock.now + .seconds(10)
            while app.store == nil && ContinuousClock.now < deadline { await Task.yield() }
            #expect(app.sheet == .newSession && app.store != nil)
            #expect(app.consumeComposePrompt(activation: app.activationGeneration) == "Keep my prompt")
        }

        @Test(arguments: [false, true])
        func unknownDefaultsNeverPresentManualTimeline(loading: Bool) async throws {
            let model = ComposeModelTests.composer()
            defer { model.teardown() }
            model.repoBranches.allowsStatusProbe = false
            model.repoPath = "/repo"; model.prompt = "Task"
            var retried = false
            try await rendered(GuardToggles(model: model, repoConfigLoading: loading,
                                           retryRepoDefaults: { retried = true }).padding()) { elements in
                #expect(!elements.contains { $0.id == "compose.guardTimeline" })
                #expect(elements.contains { $0.id == "compose.planGate.unknown" })
                #expect(elements.contains { $0.id == "compose.autopilot.unknown" })
                if !loading {
                    let retry = try #require(elements.first { $0.id == "compose.retryRepoDefaults" })
                    #expect(retry.object.accessibilityPerformPress?() == true)
                    #expect(retried)
                }
            }
            let request = try #require(model.createRequest(baseBranch: "main"))
            #expect(request.planGateEnabled == nil && request.autopilotEnabled == nil)
        }
    }
}
