import AppKit
import ApplicationServices
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
    @MainActor @Suite struct ComposeLayoutTests {
        @Test(arguments: [CGFloat(900), 1040], [CGFloat(400), 780])
        func columnsKeepFooterVisible(width: CGFloat, height: CGFloat) async throws {
            let suite = "ComposeLayout.\(UUID())"
            let defaults = try #require(UserDefaults(suiteName: suite))
            let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
                               notifications: MacTestSupport.environment(defaults: defaults))
            let store = try SessionStore(profile: .init(name: "fixture", baseURL: URL(string: "https://compose.invalid")!, mode: .remote),
                                         credentials: InMemoryCredentialStore())
            let model = ComposeModelTests.composer()
            model.repoBranches.allowsStatusProbe = false
            model.repoPath = "/repo"
            model.prompt = "Add a wishlist button to the product cards. Keep the existing cart flow."
            let host = NSHostingView(rootView: ComposeSheetContent(app: app, store: store, activation: 0, model: model))
            let window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: width, height: height),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = host
            window.orderFront(nil)
            host.layoutSubtreeIfNeeded()
            defer {
                window.orderOut(nil); window.contentView = nil
                model.teardown(); store.stop(); app.teardown()
                defaults.removePersistentDomain(forName: suite)
            }
            try await Task.sleep(for: .milliseconds(50))
            if width == 1040 && height == 780,
               let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    try png.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("shepherd-compose-parity.png"))
                }
            }
            // SwiftUI materializes its AX tree after the same system round-trip used by
            // the existing card/question-form rendering tests.
            let processID = ProcessInfo.processInfo.processIdentifier
            let status = await Task.detached {
                let application = AXUIElementCreateApplication(processID)
                AXUIElementSetMessagingTimeout(application, 0.25)
                var windows: CFTypeRef?
                return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows).rawValue
            }.value
            #expect(status == AXError.success.rawValue)
            func walk(_ object: Any, depth: Int = 0) -> [(id: String, frame: CGRect)] {
                guard depth < 60 else { return [] }
                let element = object as AnyObject
                return [(element.accessibilityIdentifier?() ?? "", element.accessibilityFrame?() ?? .zero)]
                    + (element.accessibilityChildren?() ?? []).flatMap { walk($0, depth: depth + 1) }
            }
            let elements = walk(host)
            let prompt = try #require(elements.first { $0.id == "compose.prompt" }, Comment(rawValue: "Rendered ids: " + elements.map(\.id).joined(separator: ", ")))
            let engine = try #require(elements.first { $0.id == "compose.engine" })
            let footer = try #require(elements.first { $0.id == "compose.submit" })
            let bounds = host.convert(host.bounds, to: nil)
            let screen = window.convertToScreen(bounds)
            #expect(engine.frame.minX >= prompt.frame.maxX)
            #expect(screen.contains(footer.frame))
            #expect(footer.frame.maxY <= prompt.frame.minY)
        }
    }
}
