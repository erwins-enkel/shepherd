import AppKit
import ApplicationServices
import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor
@Suite(.serialized)
struct MacCoreCompositionTests {
    @Test func resetThenRepeatedProductionPasses() async throws {
        MacStreamHost.configure()
        resetStreamSeams()
        defer { resetStreamSeams() }
        StreamRegistrations.installScene()
        #expect(!CommandRegistry.commands(in: .session).isEmpty)
        #expect(SettingsPaneRegistry.resolution == .panes)
        #expect(Set(SettingsPaneRegistry.panes.map(\.id)).isSuperset(of: ["notifications", "general"]))
        for _ in 0..<2 {
            let name = "run.shepherd.mac.composition." + UUID().uuidString
            let defaults = UserDefaults(suiteName: name)!
            defer { defaults.removePersistentDomain(forName: name) }
            let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
                notifications: MacNotificationEnvironment.make(configuration: .init(isIsolated: true, live: nil)))
            defer { app.teardown() }
            #expect(MergeInputs.planReviewBlocked(app, "fixture"))
            #expect(MergeInputs.terminalEnded(app, "fixture"))
            #expect(app.extensionFactories.isEmpty)
            StreamRegistrations.installAll(into: app)
            let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://fixture.invalid")!, mode: .remote)
            let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
            for id in ["prompt", "terminal", "activity", "plan"] {
                let tab = try #require(DetailTabRegistry.tabs.first { $0.id == id })
                _ = tab.makeView(session: PreviewData.session(), store: store, app: app)
            }
            let prompt = try #require(DetailTabRegistry.tabs.first { $0.id == "prompt" })
            let session = PreviewData.session()
            let promptView = prompt.makeView(session: session, store: store, app: app)
            #expect(rendered(promptView, as: PromptTabView.self).count == 1)
            let elements = await accessibility(promptView)
            #expect(elements.contains { $0.id == "detail-tab-prompt" })
            #expect(elements.contains { $0.text.contains(session.prompt) })
            let welcomeElements = await accessibility(AnyView(WelcomeView().environment(app)))
            let localTitle = L.t("native_welcome_local_title")
            #expect(localTitle != "native_welcome_local_title")
            #expect(welcomeElements.contains { $0.id == "welcome-local-card" })
            #expect(welcomeElements.contains { $0.text.contains(localTitle) })
            let owed = try #require(QueuesPanels.panel(for: .owed))
            #expect(rendered(owed(), as: IntegratedOwedPanel.self).count == 1)
            let sidebar = try #require(SidebarSlot.content?(app))
            let actions = try #require(ActionBarSlot.content?(session, store, app))
            #expect(rendered(sidebar, as: MergeLauncher.self).count == 1)
            #expect(rendered(actions, as: ComposeSessionActions.self).count == 1)

            // The real composition owns its predecessor; reset must release that owner.
            var probe: Probe? = Probe()
            weak var released = probe
            SidebarSlot.content = { [probe = probe!] _ in probe.sidebar += 1; return AnyView(Text("sidebar predecessor")) }
            ActionBarSlot.content = { [probe = probe!] _, _, _ in probe.actions += 1; return AnyView(Text("action predecessor")) }
            ComposeStream.install(app)
            MergeStream.install(app)
            MergeStream.install(app)
            _ = SidebarSlot.content?(app)
            _ = ActionBarSlot.content?(session, store, app)
            #expect(probe?.sidebar == 1)
            #expect(probe?.actions == 1)
            probe = nil
            #expect(released != nil)
            resetStreamSeams()
            #expect(released == nil)
            #expect(MergeInputs.git(app).isEmpty)
            #expect(!MergeInputs.reviewing(app, "fixture"))
            #expect(MergeInputs.planReviewBlocked(app, "fixture"))
            #expect(MergeInputs.terminalEnded(app, "fixture"))
            StreamRegistrations.installScene()
            StreamRegistrations.installAll(into: app)
            #expect(ActionBarSlot.content != nil)
            #expect(SidebarSlot.content != nil)
        }
    }

    private final class Probe { var sidebar = 0; var actions = 0 }

    // Inspect only value view storage, never arbitrary model/reference fields.
    private func rendered<T>(_ value: Any, as type: T.Type, depth: Int = 0) -> [T] {
        guard depth < 30 else { return [] }
        if let result = value as? T { return [result] }
        let mirror = Mirror(reflecting: value)
        guard mirror.displayStyle != .class
            || String(reflecting: Swift.type(of: value)).contains("AnyViewStorage<") else { return [] }
        return mirror.children.flatMap { rendered($0.value, as: type, depth: depth + 1) }
    }

    private struct Element { let id: String; let text: String }
    private func accessibility(_ view: AnyView) async -> [Element] {
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        defer { window.orderOut(nil); window.contentView = nil }
        let processID = ProcessInfo.processInfo.processIdentifier
        let result = await Task.detached {
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(AXUIElementCreateApplication(processID),
                kAXWindowsAttribute as CFString, &windows).rawValue
        }.value
        #expect(result == AXError.success.rawValue)
        func walk(_ object: Any, depth: Int = 0) -> [Element] {
            guard depth < 60 else { return [] }
            let element = object as AnyObject
            let value: Any? = element.accessibilityValue?()
            let current = Element(id: element.accessibilityIdentifier?() ?? "",
                text: [element.accessibilityLabel?(), value as? String].compactMap { $0 }.joined(separator: " "))
            return [current] + (element.accessibilityChildren?() ?? []).flatMap { walk($0, depth: depth + 1) }
        }
        return walk(host)
    }

}
}
