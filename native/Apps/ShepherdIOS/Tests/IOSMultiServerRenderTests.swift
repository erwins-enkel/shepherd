import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSMultiServerRenderTests: XCTestCase {
    private let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos--shepherd-worktrees-shepherd-haette-unsere-ios-gleichzeitig/17c1c8ce-3644-424d-89df-6c23ea22e71a/scratchpad/ios-multi-server/")

    func testRenderRequestedMultiServerFixtures() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let studio = try hub.catalogue.addRemoteProfile(name: "Studio", address: "https://studio.multi.fixture.invalid")
        let laptop = try hub.catalogue.addRemoteProfile(name: "Laptop", address: "https://laptop.multi.fixture.invalid")
        defer { for id in hub.connectedIDs { hub.disconnect(id) } }
        var fixtureSessions: [UUID: [Session]] = [:]
        for profile in [studio, laptop] {
            try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
            let index = profile.id == studio.id ? 1 : 2
            var work = PreviewData.session(id: "same", desig: "TASK-0\(index)", status: .init(known: .running))
            work.name = index == 1 ? "Fix terminal reconnect" : "Review session actions"
            work.prompt = index == 1 ? "Restore live output after foreground entry" : "Check archive and resume behavior"
            work.repoPath = "/fixtures/shepherd"; work.createdAt = Int(Date.now.timeIntervalSince1970 * 1000) - index * 120_000
            work.runtimeModel = "claude-sonnet-5-5"
            var sessions = [work]
            if index == 1 {
                var ready = work; ready.id = "ready"; ready.name = "Update compose tests"; ready.desig = "TASK-03"
                ready.status = .init(known: .done); ready.readyToMerge = true
                sessions.append(ready)
            }
            fixtureSessions[profile.id] = sessions
            IOSMultiServerFixtureTransport.set(sessions, for: profile.baseURL)
            await hub.connect(profile)
            try await hub.models[profile.id]?.store?.bootstrap()
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while hub.models[profile.id]?.store?.sessions.count != sessions.count, ContinuousClock.now < deadline { await Task.yield() }
            XCTAssertEqual(hub.models[profile.id]?.store?.sessions.count, sessions.count)
        }
        let app = try XCTUnwrap(hub.models[studio.id])
        let sidebar = try XCTUnwrap(app.extension(SidebarModel.self))
        XCTAssertEqual(hub.connected.count, 2)
        XCTAssertEqual(IOSMergedSessionPresentation.snapshot(hub).groups.flatMap(\.rows).count, 3)
        app.liveRequestAudit = nil
        let two = SessionListView(model: sidebar, select: { _ in }).environment(app).environment(hub)
            .environment(\.horizontalSizeClass, .compact).preferredColorScheme(.dark)
        try await saveHosted(two, name: "sessions-two-servers")

        app.liveRequestAudit = nil; app.sheet = .newSession
        let store = try XCTUnwrap(app.store)
        let compose = ComposeModel(client: store.client, defaults: launch.defaults)
        compose.repoBranches.allowsStatusProbe = false
        compose.repoPath = "/fixtures/shepherd"; compose.prompt = "Add a server picker to the task composer"
        let engine = FakeDictationEngine()
        let voice = DictationController(engine: engine, getText: { compose.prompt }, setText: { compose.prompt = $0 })
        let target = IOSComposeTarget(hub: hub)
        let renderer = ImageRenderer(content: IOSComposeContent(app: app, store: store, activation: app.activationGeneration,
            model: compose, voice: voice, serverPicker: AnyView(IOSComposeServerPicker(hub: hub, target: target)))
            .environment(\.composeRendering, true).frame(width: 390, height: 844))
        renderer.scale = 2
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("compose-server-picker.png"))
        voice.teardown(); compose.teardown(); app.sheet = nil

        hub.disconnect(laptop.id)
        var migrated = fixtureSessions[laptop.id] ?? []
        if !migrated.isEmpty { migrated[0].id = "laptop-work" }
        IOSMultiServerFixtureTransport.set((fixtureSessions[studio.id] ?? []) + migrated, for: studio.baseURL)
        try await store.refresh()
        try await saveHosted(SessionListView(model: sidebar, select: { _ in }).environment(app).environment(hub)
            .environment(\.horizontalSizeClass, .compact).preferredColorScheme(.dark), name: "sessions-one-server")
        try await saveHosted(NavigationStack { ServerListView().environment(hub.catalogue).environment(hub) }
            .preferredColorScheme(.dark), name: "servers-connected-disconnected")
    }

    /// List is UIKit-backed. Capture the production hierarchy in a private test window,
    /// then export it through ImageRenderer, as the existing terminal fixtures do.
    private func saveHosted<V: View>(_ content: V, name: String) async throws {
        let size = CGSize(width: 390, height: 844)
        let host = UIHostingController(rootView: content.frame(width: size.width, height: size.height).ignoresSafeArea(.container))
        host.safeAreaRegions = []
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host; window.isHidden = false; host.view.frame = window.bounds
        defer { window.isHidden = true; window.rootViewController = nil }
        func ready(_ view: UIView) -> Bool {
            if let list = view as? UICollectionView { return !list.visibleCells.isEmpty }
            return view.subviews.contains(where: ready)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !ready(host.view), ContinuousClock.now < deadline {
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            await Task.yield()
        }
        XCTAssertTrue(ready(host.view), "Production List must contain visible fixture rows")
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        var rendered = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            rendered = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered)
        let renderer = ImageRenderer(content: Image(uiImage: image).resizable().frame(width: size.width, height: size.height))
        renderer.scale = 2
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
    }
}
