import AppKit
import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

/// Test-scoped transport sink: every URL loading request, including a WebSocket upgrade, fails
/// locally before a connection can leave this process.
private final class TabHitDenyingProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}

extension MacSeamTests {
@MainActor
@Suite(.serialized)
struct SessionDetailTabHitTestingTests {
    private enum FixtureFailure: Error {
        case missingTabView
        case unexpectedTabCount
        case missingTabAccessibility
        case invalidTabFrame
        case invalidClickPoint
        case denyingTransportUnavailable
        case missingSelection
        case unexpectedSelection
        case missingSelectedBody
    }

    @Test func inProcessTabCentersSelectTheirMappedDetailBodies() async throws {
        MacStreamHost.configure()
        resetStreamSeams()
        defer { resetStreamSeams() }
        guard URLProtocol.registerClass(TabHitDenyingProtocol.self) else {
            throw FixtureFailure.denyingTransportUnavailable
        }
        defer { URLProtocol.unregisterClass(TabHitDenyingProtocol.self) }
        StreamRegistrations.installScene()

        let suite = "run.shepherd.mac.tab-hit." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let app = AppModel(
            defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: MacTestSupport.environment(defaults: defaults))
        defer {
            app.teardown()
            defaults.removePersistentDomain(forName: suite)
        }
        app.health = { _ in throw CancellationError() }
        app.allowsQueueRecomputation = false
        app.allowsTerminalInput = false
        StreamRegistrations.installAll(into: app)
        let profile = app.addLocalProfile(port: 1)
        await app.activate(profile)
        let store = try #require(app.store)
        // The denying protocol keeps bootstrap, detail reads and a terminal attachment local.
        // The frame provides the one selected session the real detail view requires.
        store.apply(.sessionNew(PreviewData.session(id: "fixture")))
        app.selectedSessionID = "fixture"

        let session = try #require(store.session(id: "fixture"))
        let host = NSHostingView(rootView: SessionDetailView(session: session).environment(app))
        let window = NSWindow(
            contentRect: NSRect(x: -10_000, y: -10_000, width: 1_280, height: 900),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        defer {
            window.orderOut(nil)
            window.contentView = nil
        }
        settle(host)

        let tabView = try #require(findDescendant(in: host, as: NSTabView.self))
        let expected = [
            ("terminal", "detail-tab-terminal"),
            ("activity", "detail-tab-activity"),
            ("diff", "detail-tab-diff"),
            ("files", "detail-tab-files"),
            ("git", "detail-tab-git"),
            ("plan", "detail-tab-plan"),
        ]
        guard tabView.numberOfTabViewItems == 8 else { throw FixtureFailure.unexpectedTabCount }

        for (index, expectedTab) in expected.enumerated() {
            try sendCenterClick(at: tabFrame(at: index, in: tabView), in: window)
            settle(host)
            let selected = try #require(tabView.selectedTabViewItem)
            guard tabView.indexOfTabViewItem(selected) == index,
                  selected.identifier as? String == expectedTab.0
            else { throw FixtureFailure.unexpectedSelection }
            guard let selectedView = selected.view,
                  containsAccessibilityIdentifier(expectedTab.1, in: selectedView)
            else { throw FixtureFailure.missingSelectedBody }
        }
    }

    private func findDescendant<View: NSView>(in root: NSView, as type: View.Type) -> View? {
        if let result = root as? View { return result }
        for child in root.subviews {
            if let result = findDescendant(in: child, as: type) { return result }
        }
        return nil
    }

    private func accessibilityFrame(of value: Any) -> NSRect? {
        let element = value as AnyObject
        return element.accessibilityFrame?() as? NSRect
    }

    private func tabFrame(at index: Int, in tabView: NSTabView) throws -> NSRect {
        let children = tabView.accessibilityChildren() ?? []
        guard index < children.count,
              let frame = accessibilityFrame(of: children[index]),
              frame.origin.x.isFinite, frame.origin.y.isFinite,
              frame.width.isFinite, frame.height.isFinite,
              frame.width > 0, frame.height > 0
        else { throw FixtureFailure.missingTabAccessibility }
        return frame
    }

    private func sendCenterClick(at screenFrame: NSRect, in window: NSWindow) throws {
        let point = window.convertPoint(fromScreen: NSPoint(x: screenFrame.midX, y: screenFrame.midY))
        guard point.x.isFinite, point.y.isFinite else { throw FixtureFailure.invalidClickPoint }
        guard let down = NSEvent.mouseEvent(
            with: .leftMouseDown, location: point, modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
              let up = NSEvent.mouseEvent(
                with: .leftMouseUp, location: point, modifierFlags: [], timestamp: 0,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)
        else { throw FixtureFailure.invalidClickPoint }
        // A tab's mouse-down handling can synchronously wait for its matching up event. Put the
        // targeted local event on this test host's AppKit queue before delivering the down event.
        NSApp.postEvent(up, atStart: false)
        window.sendEvent(down)
        guard let queuedUp = NSApp.nextEvent(
            matching: .leftMouseUp, until: Date().addingTimeInterval(0.025), inMode: .default,
            dequeue: true), queuedUp.windowNumber == window.windowNumber
        else { throw FixtureFailure.invalidClickPoint }
        window.sendEvent(queuedUp)
    }

    private func containsAccessibilityIdentifier(_ identifier: String, in value: AnyObject, depth: Int = 0) -> Bool {
        guard depth < 60 else { return false }
        if value.accessibilityIdentifier?() == identifier { return true }
        return (value.accessibilityChildren?() ?? []).contains {
            containsAccessibilityIdentifier(identifier, in: $0 as AnyObject, depth: depth + 1)
        }
    }

    private func settle(_ host: NSHostingView<some View>) {
        for _ in 0..<4 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.025))
        }
    }
}
}
