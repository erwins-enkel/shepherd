import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSServerHubTests: XCTestCase {
    private func fixture(restored: Bool = false) throws -> (IOSLaunchEnvironment, IOSServerHub, ServerProfile, ServerProfile) {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let makeModel: (UUID) -> AppModel = { id in
            let app = launch.makeModel(activeProfileKey: "active.\(id)", persistsProfileCatalogue: false)
            app.liveRequestAudit = nil
            app.makeClient = { profile, credentials, audit in
                let configuration = IOSLaunchEnvironment.requestSession.configuration
                configuration.protocolClasses = [IOSMultiServerFixtureTransport.self]
                return try ShepherdClient(profile: profile, credentials: credentials,
                    readOnlyAudit: audit, requestAttempts: 1, readURLSession: URLSession(configuration: configuration))
            }
            return app
        }
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: launch.makeModel(activeProfileKey: "catalogue"), makeModel: makeModel)
        let run = UUID().uuidString.lowercased()
        let a = try hub.catalogue.addRemoteProfile(name: "Studio", address: "https://a-\(run).multi.fixture.invalid")
        let b = try hub.catalogue.addRemoteProfile(name: "Laptop", address: "https://b-\(run).multi.fixture.invalid")
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        for profile in [a, b] {
            try launch.credentials.save(.init(token: "fixture-token", tokenId: "fixture"), for: profile.credentialKey)
        }
        if restored {
            launch.defaults.set([a.id.uuidString, b.id.uuidString], forKey: IOSServerHub.connectedKey)
            return (launch, IOSServerHub(defaults: launch.defaults, catalogue: hub.catalogue, makeModel: makeModel), a, b)
        }
        return (launch, hub, a, b)
    }
    private func stop(_ hub: IOSServerHub) { for id in hub.connectedIDs { hub.disconnect(id) } }

    func testUnavailableFirstServerDoesNotOwnHealthyFocusOrCompose() async throws {
        let (_, hub, dead, live) = try fixture(restored: true)
        defer { stop(hub) }
        IOSMultiServerFixtureTransport.setUnavailable(true, for: dead.baseURL)
        IOSMultiServerFixtureTransport.set([PreviewData.session(id: "healthy", desig: "TASK-1", status: .init(known: .running))], for: live.baseURL)
        await hub.start(launch: try IOSLaunchEnvironment(configuration: .init()))
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (!hub.hasLoadedList || hub.models[dead.id]?.store?.connection == .connecting || hub.models[live.id]?.store?.connection != .live), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(hub.hasLoadedList)
        XCTAssertNotNil(hub.models[live.id]?.store?.session(id: "healthy"))
        XCTAssertTrue(hub.focused === hub.models[live.id])
        XCTAssertTrue(hub.composeModel === hub.models[live.id])
        let target = IOSComposeTarget(hub: hub)
        XCTAssertEqual(target.profileID, live.id)
        target.select(dead.id, hub: hub)
        XCTAssertEqual(target.profileID, dead.id, "Offline servers remain explicitly selectable")
    }

    private func settle(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }

    func testImplicitFocusFallsBackWhenItsServerBecomesUnavailable() async throws {
        let (_, hub, a, b) = try fixture(restored: true)
        defer { stop(hub) }
        await hub.start(launch: try IOSLaunchEnvironment(configuration: .init()))
        await settle { hub.connected.allSatisfy(hub.isLive) }
        XCTAssertEqual(hub.focusedID, a.id)
        IOSMultiServerFixtureTransport.setUnavailable(true, for: a.baseURL)
        hub.refreshServers()
        await settle { hub.unavailableIDs.contains(a.id) }
        XCTAssertEqual(hub.focusedID, b.id)
        XCTAssertEqual(IOSComposeTarget(hub: hub).profileID, b.id)
    }

    func testExplicitConnectFocusAndSelectionSurviveUnavailableServer() async throws {
        let (_, hub, dead, live) = try fixture()
        defer { stop(hub) }
        IOSMultiServerFixtureTransport.setUnavailable(true, for: dead.baseURL)
        await hub.connect(live)
        await settle { hub.models[live.id].map(hub.isLive) == true }
        await hub.connect(dead)
        XCTAssertEqual(hub.focusedID, dead.id, "Connect wins even before the first snapshot")
        await settle { hub.unavailableIDs.contains(dead.id) }
        XCTAssertEqual(hub.focusedID, dead.id)
        XCTAssertEqual(IOSComposeTarget(hub: hub).profileID, dead.id)
        hub.focus(live.id)
        await hub.connect(dead)
        XCTAssertEqual(hub.focusedID, dead.id, "Connecting an existing profile also focuses it")
        hub.focus(live.id)
        hub.focus(dead.id)
        XCTAssertEqual(hub.focusedID, dead.id)
        hub.select(.init(profileID: live.id, sessionID: "fixture"))
        hub.select(.init(profileID: dead.id, sessionID: "fixture"))
        hub.focused.selectedSessionID = nil
        XCTAssertEqual(hub.focusedID, dead.id, "Closing detail does not undo explicit focus")
    }

    func testHangingPeerCannotDelayHealthyListRefreshComposeOrNotification() async throws {
        let (_, hub, dead, live) = try fixture()
        defer { stop(hub) }
        IOSMultiServerFixtureTransport.setHanging(true, for: dead.baseURL)
        let session = PreviewData.session(id: "healthy", status: .init(known: .running))
        IOSMultiServerFixtureTransport.set([session], for: live.baseURL)
        await hub.connect(dead)
        XCTAssertFalse(hub.showsUnavailableNotice(dead.id), "The first attempt is not an outage yet")
        await hub.connect(live)
        await settle { hub.models[live.id]?.store?.connection == .live && IOSMultiServerFixtureTransport.hasStarted(dead.baseURL) }
        XCTAssertTrue(hub.hasSidebar && hub.hasLoadedList)
        XCTAssertTrue(hub.focused === hub.models[live.id])
        XCTAssertEqual(IOSComposeTarget(hub: hub).profileID, live.id)
        let registration = IOSPushRegistration()
        registration.attach(hub, enabled: false)
        registration.open("healthy")
        XCTAssertEqual(registration.notificationChoices, [.init(profileID: live.id, sessionID: "healthy")])
        registration.chooseNotification(.init(profileID: live.id, sessionID: "healthy"))
        XCTAssertEqual(hub.selection?.profileID, live.id)
        IOSMultiServerFixtureTransport.set([session, PreviewData.session(id: "fresh", status: .init(known: .running))], for: live.baseURL)
        hub.refreshServers()
        await settle { hub.models[live.id]?.store?.session(id: "fresh") != nil }
        XCTAssertFalse(hub.models[dead.id]?.store?.hasLoadedSessions == true)
        await settle { hub.showsUnavailableNotice(dead.id) }
        XCTAssertFalse(hub.awaitsNotificationLookup(try XCTUnwrap(hub.models[dead.id])))
        hub.dismissUnavailableNotice(dead.id)
        XCTAssertFalse(hub.showsUnavailableNotice(dead.id))
        XCTAssertTrue(hub.hasLoadedList)
    }

    func testDismissedOutageRecoversAutomaticallyAndANewOutageShowsAgain() async throws {
        let (_, hub, dead, live) = try fixture()
        defer { stop(hub) }
        IOSMultiServerFixtureTransport.setUnavailable(true, for: dead.baseURL)
        await hub.connect(dead); await hub.connect(live)
        await settle { hub.showsUnavailableNotice(dead.id) && hub.models[live.id]?.store?.hasLoadedSessions == true }
        hub.dismissUnavailableNotice(dead.id)
        XCTAssertFalse(hub.showsUnavailableNotice(dead.id))
        let recovered = PreviewData.session(id: "recovered", status: .init(known: .running))
        IOSMultiServerFixtureTransport.set([recovered], for: dead.baseURL)
        IOSMultiServerFixtureTransport.setUnavailable(false, for: dead.baseURL)
        // No Retry: the store's existing capped-backoff loop must recover this profile.
        await settle { hub.models[dead.id]?.store?.session(id: "recovered") != nil && !hub.unavailableIDs.contains(dead.id) }
        XCTAssertFalse(hub.showsUnavailableNotice(dead.id))
        IOSMultiServerFixtureTransport.setUnavailable(true, for: dead.baseURL)
        hub.models[dead.id]?.retry() // The foreground recovery path also reconciles through AppModel.
        await settle { hub.showsUnavailableNotice(dead.id) }
        XCTAssertTrue(hub.hasLoadedList)
        XCTAssertTrue(hub.composeModel === hub.models[live.id])
        hub.dismissUnavailableNotice(dead.id)
        hub.refreshServers()
        XCTAssertFalse(hub.showsUnavailableNotice(dead.id), "Retries do not undo dismissal during the same outage")
    }

    func testUnavailableNoticePersistsUntilClosedAndStringsResolveInBothLocales() async throws {
        let (_, hub, dead, live) = try fixture()
        defer { stop(hub) }
        IOSMultiServerFixtureTransport.setUnavailable(true, for: dead.baseURL)
        await hub.connect(dead); await hub.connect(live)
        await settle { hub.showsUnavailableNotice(dead.id) }
        IOSMultiServerFixtureTransport.setUnavailable(false, for: dead.baseURL)
        await settle { hub.models[dead.id]?.store?.hasLoadedSessions == true && !hub.unavailableIDs.contains(dead.id) }
        XCTAssertTrue(hub.showsUnavailableNotice(dead.id), "The operator owns notice dismissal")
        hub.dismissUnavailableNotice(dead.id)
        XCTAssertFalse(hub.showsUnavailableNotice(dead.id))
        for locale in ["en", "de"] {
            let path = try XCTUnwrap(CoreResources.bundle.path(forResource: locale, ofType: "lproj"))
            let bundle = try XCTUnwrap(Bundle(path: path))
            let format = bundle.localizedString(forKey: "native_ios_server_unavailable", value: nil, table: nil)
            let text = String(format: format, "Laptop")
            XCTAssertEqual(text, locale == "de" ? "Laptop ist gerade nicht erreichbar" : "Laptop is currently unavailable")
        }
    }

    func testRenderUnavailableNoticeAlongsideUsableSession() async throws {
        let (_, hub, dead, live) = try fixture()
        defer { stop(hub) }
        let session = PreviewData.session(id: "healthy", desig: "TASK-1", status: .init(known: .running))
        IOSMultiServerFixtureTransport.setUnavailable(true, for: dead.baseURL)
        IOSMultiServerFixtureTransport.set([session], for: live.baseURL)
        await hub.connect(dead); await hub.connect(live)
        await settle { hub.showsUnavailableNotice(dead.id) && hub.hasLoadedList }
        let directory = URL(fileURLWithPath: "/tmp/shepherd-ios-unreachable")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, size) in [("notice", DynamicTypeSize.large), ("notice-accessibility", .accessibility3)] {
            let renderer = ImageRenderer(content: VStack(spacing: 12) {
                ConnectionStatusView().environment(hub)
                SessionCardView(card: IOSSessionListPresentation.card(session, displayed: session, now: 0), select: {})
            }.environment(\.dynamicTypeSize, size).padding(.vertical, 12)
                .frame(width: 390).background(SessionListStyle.background).preferredColorScheme(.dark))
            renderer.scale = 2
            try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
        }
    }

    func testRestoredServersStartWithoutJoiningASuspendedPeerActivation() async throws {
        let (launch, hub, dead, live) = try fixture()
        launch.defaults.set([dead.id.uuidString, live.id.uuidString], forKey: IOSServerHub.connectedKey)
        let restored = IOSServerHub(defaults: launch.defaults, catalogue: hub.catalogue) { id in
            let app = launch.makeModel(activeProfileKey: "restore.\(id)", persistsProfileCatalogue: false)
            app.liveRequestAudit = nil
            app.makeClient = { profile, credentials, audit in
                let configuration = IOSLaunchEnvironment.requestSession.configuration
                configuration.protocolClasses = [IOSMultiServerFixtureTransport.self]
                return try ShepherdClient(profile: profile, credentials: credentials,
                    readOnlyAudit: audit, requestAttempts: 1, readURLSession: URLSession(configuration: configuration))
            }
            return app
        }
        defer { stop(restored) }
        let peer = try XCTUnwrap(restored.models[dead.id])
        let latch = HubProbeLatch()
        peer.credentialProbe = { _, _ in await latch.wait(); return .init(token: "fixture", tokenId: "fixture") }
        // Only selects the production dispatch branch; all models and credentials remain isolated.
        let normalDispatch = try IOSLaunchEnvironment(configuration: .init())
        var returned = false
        let start = Task { await restored.start(launch: normalDispatch); returned = true }
        await settle { restored.models[live.id]?.store?.hasLoadedSessions == true && returned }
        XCTAssertNil(peer.store)
        XCTAssertNil(peer.credentialAccessWarning, "Startup must return before the held credential wait expires")
        await latch.release()
        await start.value
        await settle { peer.store != nil }
    }

    func testIOSRequestBudgetIsBoundedWithoutChangingSharedSession() {
        let configuration = IOSLaunchEnvironment.requestSession.configuration
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 8)
        XCTAssertEqual(configuration.timeoutIntervalForResource, 30)
        XCTAssertFalse(configuration.waitsForConnectivity)
        XCTAssertEqual(URLSession.shared.configuration.timeoutIntervalForRequest, 60)
    }

    func testConnectIsAdditiveDisconnectParksAndRemoveDeletesCredential() async throws {
        let (launch, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        let first = try XCTUnwrap(hub.models[a.id]), second = try XCTUnwrap(hub.models[b.id])
        XCTAssertEqual(hub.connectedIDs, [a.id, b.id])
        XCTAssertEqual(first.activeProfile, a); XCTAssertEqual(second.activeProfile, b)
        XCTAssertFalse(first.store === second.store)
        await hub.connect(a)
        XCTAssertTrue(hub.models[a.id] === first)
        hub.disconnect(a.id)
        XCTAssertNil(first.store); XCTAssertNotNil(second.store)
        XCTAssertNotNil(try launch.credentials.load(for: a.credentialKey))
        XCTAssertEqual(hub.focusedID, b.id)
        await hub.remove(b)
        XCTAssertNil(second.store)
        XCTAssertFalse(hub.profiles.contains { $0.id == b.id })
        XCTAssertNil(try launch.credentials.load(for: b.credentialKey))
        XCTAssertTrue(hub.connected.isEmpty)
        XCTAssertEqual(launch.defaults.array(forKey: IOSServerHub.connectedKey) as? [String], [])
    }

    func testPairingReusesProfileFocusesItAndPreservesOtherServer() async throws {
        let (launch, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(b)
        await hub.connect(a, login: true)
        let model = try XCTUnwrap(hub.models[a.id])
        let other = try XCTUnwrap(hub.models[b.id])
        model.pairingExchange = { profile, code, deviceName, credentials in
            XCTAssertEqual(code, "shpp_" + String(repeating: "a", count: 43))
            XCTAssertEqual(deviceName, "Test iPhone")
            try credentials.save(.init(token: "fixture-paired", tokenId: "paired"), for: profile.credentialKey)
        }
        var url = URLComponents(string: "shepherd://pair")!
        url.queryItems = [.init(name: "server", value: a.baseURL.absoluteString),
            .init(name: "code", value: "shpp_" + String(repeating: "a", count: 43))]
        let link = try XCTUnwrap(PairingLink.parse(url.string!))
        try await hub.pair(link: link, deviceName: "Test iPhone")
        XCTAssertEqual(hub.profiles.count, 2)
        XCTAssertEqual(hub.focusedID, a.id)
        XCTAssertTrue(hub.models[b.id] === other)
        XCTAssertNotNil(other.store)
        XCTAssertNotNil(model.store)
        XCTAssertNil(model.sheet)
        XCTAssertEqual(try launch.credentials.load(for: a.credentialKey)?.tokenId, "paired")
    }

    /// A cold launch renders the root before any restored server has activated.
    /// The session list must appear once one has, without another UI event.
    func testHasSidebarNotifiesObserversWhenARestoredServerActivates() async throws {
        let (_, hub, a, _) = try fixture()
        defer { stop(hub) }
        await hub.connect(a, login: true)
        let app = try XCTUnwrap(hub.models[a.id])
        app.sheet = nil
        let changed = expectation(description: "hasSidebar observers are notified")
        XCTAssertFalse(withObservationTracking { hub.hasSidebar } onChange: { changed.fulfill() })
        await app.activate(a)
        await fulfillment(of: [changed], timeout: 1)
        XCTAssertTrue(hub.hasSidebar)
    }

    func testNewServerRoutesLoginImmediatelyWithoutStartingAStore() async throws {
        let (_, hub, a, _) = try fixture()
        defer { stop(hub) }
        await hub.connect(a, login: true)
        let app = try XCTUnwrap(hub.models[a.id])
        XCTAssertNil(app.store)
        XCTAssertEqual(app.sheet, .login(a))
        XCTAssertTrue(hub.routedSheet?.model === app)
    }

    func testRemovalRevokesATokenMintedAfterTheConnectionWasRemoved() async throws {
        let (launch, hub, a, _) = try fixture()
        await hub.connect(a, login: true)
        let app = try XCTUnwrap(hub.models[a.id])
        let latch = HubProbeLatch()
        var revoked: [String] = []
        app.login = { profile, _, credentials in
            await latch.wait()
            try credentials.save(.init(token: "late-fixture", tokenId: "late"), for: profile.credentialKey)
        }
        app.logout = { profile, credentials in
            if let token = try credentials.load(for: profile.credentialKey) { revoked.append(token.tokenId) }
            try credentials.delete(for: profile.credentialKey)
        }
        let login = Task { try await app.signIn(profile: a, password: "fixture") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        await hub.remove(a)
        await latch.release()
        try await login.value
        XCTAssertTrue(revoked.contains("late"))
        XCTAssertNil(try launch.credentials.load(for: a.credentialKey))
        XCTAssertNil(app.store)
        XCTAssertNil(hub.models[a.id])
        XCTAssertFalse(hub.profiles.contains { $0.id == a.id })
    }

    func testMigrationRestoresLegacyOnceAndEmptyConnectedSetStaysDisconnected() throws {
        let (launch, _, a, b) = try fixture()
        launch.defaults.removeObject(forKey: IOSServerHub.connectedKey)
        launch.defaults.set(b.id.uuidString, forKey: "run.shepherd.mac.activeProfileID")
        let migrated = IOSServerHub(launch: launch)
        XCTAssertEqual(migrated.connectedIDs, [b.id]); XCTAssertEqual(migrated.focusedID, b.id)
        XCTAssertEqual(launch.defaults.array(forKey: IOSServerHub.connectedKey) as? [String], [b.id.uuidString])
        migrated.disconnect(b.id)
        let parked = IOSServerHub(launch: launch)
        XCTAssertTrue(parked.connectedIDs.isEmpty)
        XCTAssertEqual(parked.profiles.map(\.id), [a.id, b.id])
    }

    func testPersistenceDeduplicatesAndDropsRemovedOrMalformedIDs() async throws {
        let (launch, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        let restored = IOSServerHub(launch: launch)
        defer { stop(restored) }
        XCTAssertEqual(restored.connectedIDs, [a.id, b.id])
        launch.defaults.set([a.id.uuidString, a.id.uuidString, "broken", UUID().uuidString], forKey: IOSServerHub.connectedKey)
        let sanitized = IOSServerHub(launch: launch)
        defer { stop(sanitized) }
        XCTAssertEqual(sanitized.connectedIDs, [a.id])
    }

    func testNotificationServerIdentityAndLegacyCollisionNeverSelectWrongStore() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        let first = try XCTUnwrap(hub.models[a.id]?.store), second = try XCTUnwrap(hub.models[b.id]?.store)
        try await first.bootstrap(); try await second.bootstrap()
        let duplicate = PreviewData.session(id: "same", desig: "TASK-1", status: .init(known: .running))
        IOSMultiServerFixtureTransport.set([duplicate], for: a.baseURL)
        IOSMultiServerFixtureTransport.set([duplicate], for: b.baseURL)
        try await first.refresh(); try await second.refresh()
        XCTAssertEqual(hub.notificationTargets(sessionID: "same", server: b.baseURL.absoluteString), [.init(profileID: b.id, sessionID: "same")])
        XCTAssertEqual(hub.notificationTargets(sessionID: "same", server: b.id.uuidString), [.init(profileID: b.id, sessionID: "same")])
        XCTAssertEqual(hub.notificationTargets(sessionID: "same", server: nil).count, 2)
        XCTAssertTrue(hub.notificationTargets(sessionID: "same", server: "https://unknown.invalid").isEmpty)
        let registration = IOSPushRegistration()
        registration.attach(hub, enabled: false)
        registration.open("same")
        XCTAssertNil(hub.selection); XCTAssertEqual(registration.notificationChoices.count, 2)
        registration.chooseNotification(.init(profileID: b.id, sessionID: "same"))
        XCTAssertEqual(hub.selection, .init(profileID: b.id, sessionID: "same"))
        XCTAssertNil(hub.models[a.id]?.selectedSessionID)
        registration.open("same", server: a.baseURL.absoluteString)
        XCTAssertEqual(hub.selection, .init(profileID: a.id, sessionID: "same"))
        XCTAssertNil(hub.models[b.id]?.selectedSessionID)
        IOSMultiServerFixtureTransport.set([duplicate, PreviewData.session(id: "unique", desig: "TASK-2", status: .init(known: .running))], for: a.baseURL)
        try await first.refresh()
        registration.open("unique")
        XCTAssertEqual(hub.selection?.profileID, a.id)
    }

    func testNotificationWaitsForTheTargetStoreOnColdStart() async throws {
        let (_, hub, a, _) = try fixture()
        defer { stop(hub) }
        let registration = IOSPushRegistration()
        registration.attach(hub, enabled: false)
        registration.open("cold", server: a.baseURL.absoluteString)
        XCTAssertNil(hub.selection)
        let session = PreviewData.session(id: "cold", desig: "TASK-1", status: .init(known: .running))
        IOSMultiServerFixtureTransport.set([session], for: a.baseURL)
        await hub.connect(a)
        try await hub.models[a.id]?.store?.refresh()
        let store = try XCTUnwrap(hub.models[a.id]?.store)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (!store.hasLoadedSessions || store.session(id: "cold") == nil), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(store.hasLoadedSessions)
        XCTAssertNotNil(store.session(id: "cold"))
        registration.routePendingNotification()
        XCTAssertEqual(hub.selection, .init(profileID: a.id, sessionID: "cold"))
    }

    func testComposerDefaultsToFocusAndUsesChosenServerClient() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        await settle { hub.models[a.id].map(hub.isLive) == true && hub.models[b.id].map(hub.isLive) == true }
        hub.focus(b.id)
        let target = IOSComposeTarget(hub: hub)
        XCTAssertEqual(target.profileID, b.id)
        target.select(a.id, hub: hub)
        let selected = try XCTUnwrap(target.model(in: hub))
        XCTAssertTrue(selected === hub.models[a.id])
        target.select(UUID(), hub: hub)
        XCTAssertEqual(target.profileID, a.id)
        selected.liveRequestAudit = nil
        let store = try XCTUnwrap(selected.store)
        let outcome = try await store.client.createSession(.init(repoPath: "/fixtures/shepherd", baseBranch: "main", prompt: "Fixture"))
        guard case .created(let session) = outcome else { XCTFail("Expected creation"); return }
        store.apply(.sessionNew(session))
        // start() can still be fetching its first snapshot; events are buffered until
        // the snapshot lands, so observe the accepted state rather than the enqueue.
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while store.session(id: session.id) == nil, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(store.session(id: session.id)?.id, "compose-created")
        XCTAssertNil(hub.models[b.id]?.store?.session(id: session.id))
        XCTAssertEqual(store.client.profile.baseURL, a.baseURL)
    }

    func testComposerRepoListMergesServersAndRoutesToTheServerCarryingIt() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        func repo(_ name: String, _ path: String, slug: String? = nil) -> String {
            #"{"name":"\#(name)","path":"\#(path)","display":"\#(name)","realPath":"\#(path)","isFork":false,"hidden":false\#(slug.map { #","remoteSlug":"\#($0)""# } ?? "")}"#
        }
        IOSMultiServerFixtureTransport.setRepos("[\(repo("shepherd", "/studio/shepherd", slug: "kai/shepherd")),\(repo("site", "/studio/site"))]", for: a.baseURL)
        IOSMultiServerFixtureTransport.setRepos("[\(repo("Shepherd", "/laptop/code/shepherd", slug: "Kai/Shepherd")),\(repo("notes", "/laptop/notes"))]", for: b.baseURL)
        await hub.connect(a); await hub.connect(b)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while hub.connected.contains(where: { $0.store?.repos.isEmpty != false }), ContinuousClock.now < deadline {
            for model in hub.connected { try? await model.store?.refresh() }
            await Task.yield()
        }
        let choices = IOSComposeRepoChoice.choices(hub)
        XCTAssertEqual(choices.map(\.name), ["notes", "shepherd", "site"])
        let shared = try XCTUnwrap(choices.first { $0.name == "shepherd" })
        XCTAssertEqual(shared.paths, [a.id: "/studio/shepherd", b.id: "/laptop/code/shepherd"])

        await settle { hub.models[a.id].map(hub.isLive) == true && hub.models[b.id].map(hub.isLive) == true }
        hub.focus(a.id)
        let target = IOSComposeTarget(hub: hub)
        XCTAssertEqual(target.profileID, a.id)
        XCTAssertEqual(target.servers(in: hub), [a.id, b.id])
        target.pick(try XCTUnwrap(choices.first { $0.name == "notes" }), hub: hub)
        XCTAssertEqual(target.profileID, b.id, "a repo only the laptop has moves the task there")
        XCTAssertEqual(target.servers(in: hub), [b.id])
        XCTAssertEqual(target.repoPath(in: hub), "/laptop/notes")

        target.pick(shared, hub: hub)
        XCTAssertEqual(target.profileID, b.id, "a repo on both servers keeps the current one")
        XCTAssertEqual(target.servers(in: hub), [a.id, b.id])
        target.select(a.id, hub: hub)
        XCTAssertEqual(target.repoPath(in: hub), "/studio/shepherd", "switching server keeps the repo")
        target.repoChanged("/studio/site", hub: hub)
        XCTAssertEqual(target.servers(in: hub), [a.id])
    }

    func testComposerCapacityUsesEachTargetServersSettingsUsageAndDiagnostics() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        let settings = #"{"repoRoot":"/fixtures","repoRootDisplay":"/fixtures","firstRunPending":false,"defaultModel":"sonnet","defaultCodexModel":"gpt-6-astra","defaultEffort":"high","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"de","usageHoldEnabled":true,"usageHoldPct":80}"#
        IOSMultiServerFixtureTransport.setSettings(settings, for: a.baseURL)
        IOSMultiServerFixtureTransport.setSettings(settings.replacingOccurrences(of: "\"usageHoldPct\":80", with: "\"usageHoldPct\":90"), for: b.baseURL)
        await hub.connect(a); await hub.connect(b)
        let appA = try XCTUnwrap(hub.models[a.id]), appB = try XCTUnwrap(hub.models[b.id])
        let storeA = try XCTUnwrap(appA.store), storeB = try XCTUnwrap(appB.store)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (!storeA.hasLoadedSessions || !storeB.hasLoadedSessions), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(storeA.hasLoadedSessions && storeB.hasLoadedSessions)
        let recoveryA = try XCTUnwrap(appA.extension(BackendRecoveryModel.self))
        let recoveryB = try XCTUnwrap(appB.extension(BackendRecoveryModel.self))
        await recoveryA.refresh(); await recoveryB.refresh()
        let limits = UsageLimits(session5h: .init(pct: 85, resetAt: 0), week: nil,
            perModelWeek: [], credits: nil, stale: false, calibratedAt: nil, subscriptionOnly: false)
        storeA.apply(.usageLimits(limits)); storeB.apply(.usageLimits(limits))
        let usageDeadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (SessionSignals.usageLimits(for: appA)?.session5h?.pct != 85 || SessionSignals.usageLimits(for: appB)?.session5h?.pct != 85), ContinuousClock.now < usageDeadline { await Task.yield() }
        XCTAssertEqual(SessionSignals.usageLimits(for: appA)?.session5h?.pct, 85)
        XCTAssertEqual(SessionSignals.usageLimits(for: appB)?.session5h?.pct, 85)
        await settle { hub.models[a.id].map(hub.isLive) == true && hub.models[b.id].map(hub.isLive) == true }
        hub.focus(a.id)
        let target = IOSComposeTarget(hub: hub)
        target.prompt = "Keep this prompt"
        func compose() throws -> IOSComposeContent {
            let app = try XCTUnwrap(target.model(in: hub)), store = try XCTUnwrap(app.store)
            let voice = DictationController(engine: FakeDictationEngine(), getText: { "" }, setText: { _ in })
            return IOSComposeContent(app: app, store: store, activation: app.activationGeneration, voice: voice,
                initialPrompt: target.prompt, initialRepoPath: "/fixtures/shepherd")
        }
        let first = try compose()
        defer { first.model.teardown(); first.voice.teardown() }
        XCTAssertEqual(first.model.provider, .codex)
        target.select(b.id, hub: hub)
        let second = try compose()
        defer { second.model.teardown(); second.voice.teardown() }
        XCTAssertEqual(second.model.provider, .claude)
        XCTAssertEqual(second.model.prompt, "Keep this prompt")
        var high = limits; high.session5h = .init(pct: 95, resetAt: 0)
        storeB.apply(.usageLimits(high))
        IOSMultiServerFixtureTransport.setDiagnostics(#"{"checks":[{"id":"claude","state":"ok","hintKey":"fixture"},{"id":"codex","state":"optional","hintKey":"fixture"}],"generatedAt":1,"overall":"ok"}"#, for: b.baseURL)
        await recoveryB.refresh()
        let unavailable = try compose()
        defer { unavailable.model.teardown(); unavailable.voice.teardown() }
        XCTAssertEqual(unavailable.model.provider, .claude)
        XCTAssertTrue(unavailable.readiness.dualCTA)
        target.select(a.id, hub: hub)
        let back = try compose()
        defer { back.model.teardown(); back.voice.teardown() }
        XCTAssertEqual(back.model.provider, .codex)
        target.select(b.id, hub: hub)
        hub.disconnect(a.id)
        recoveryA.replaceDiagnostics(try JSONDecoder().decode(DiagnosticsSnapshot.self,
            from: Data(IOSMultiServerFixtureTransport.readyDiagnostics.utf8)))
        XCTAssertNil(recoveryA.diagnostics)
        XCTAssertEqual(recoveryB.diagnostics?.checks.first { $0.id == "codex" }?.state.rawValue, "optional")
    }

    /// The settings menu reports push for the focused server, not whichever server answered last
    /// (#2696): one server has an APNs key, the other answers 503.
    func testPushStatusIsPerServer() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        let storeA = try XCTUnwrap(hub.models[a.id]?.store)
        let storeB = try XCTUnwrap(hub.models[b.id]?.store)
        let registration = IOSPushRegistration()
        registration.registerDevice = { store, _ in
            store === storeA ? .registered(endpoint: "fixture") : .unavailable
        }
        registration.attach(hub, enabled: true)
        XCTAssertEqual(registration.status(for: storeA), .idle)
        registration.didRegister(deviceToken: Data([1, 2]))
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while registration.status(for: storeA) == .idle || registration.status(for: storeB) == .idle,
              ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(registration.status(for: storeA), .registered)
        XCTAssertEqual(registration.status(for: storeB), .unavailable)
        XCTAssertEqual(registration.status(for: nil), .idle)
    }

    func testPushTokenRegistersOnEveryStoreOnceAndAgainAfterReconnect() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        let registration = IOSPushRegistration()
        var targets: [String] = []
        var receivedTokens: [String] = []
        registration.registerDevice = { store, token in
            receivedTokens.append(token)
            targets.append(store.client.profile.baseURL.absoluteString)
            return .registered(endpoint: "fixture")
        }
        registration.attach(hub, enabled: true)
        registration.didRegister(deviceToken: Data([1, 2]))
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while targets.count < 2 && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(Set(targets), Set([a.baseURL.absoluteString, b.baseURL.absoluteString]))
        registration.storeChanged()
        hub.disconnect(b.id); await hub.connect(b)
        registration.storeChanged()
        while targets.count < 3 && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(targets.count, 3)
        XCTAssertEqual(targets.filter { $0 == b.baseURL.absoluteString }.count, 2)
        XCTAssertEqual(receivedTokens, ["0102", "0102", "0102"])
        registration.didRegister(deviceToken: Data([3, 4]))
        while targets.count < 5 && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(targets.count, 5)
        XCTAssertEqual(Array(receivedTokens.suffix(2)), ["0304", "0304"])
    }

    func testCredentialAccessFailureRetriesWithoutRequestingAnotherLogin() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let catalogue = launch.makeModel(activeProfileKey: "catalogue")
        let profile = try catalogue.addRemoteProfile(name: "Saved", address: "https://compose.fixture.invalid")
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: catalogue) { id in
            let app = launch.makeModel(activeProfileKey: "active.\(id)", persistsProfileCatalogue: false)
            app.credentialProbe = { _, _ in throw KeychainError.unexpectedStatus(-25308) }
            return app
        }
        defer { stop(hub) }
        await hub.connect(profile)
        let app = try XCTUnwrap(hub.models[profile.id])
        XCTAssertNotNil(app.credentialAccessWarning)
        XCTAssertNil(app.sheet)
        app.credentialProbe = { _, _ in StoredCredential(token: "test", tokenId: "test") }
        await hub.connect(profile)
        XCTAssertNil(app.sheet)
        XCTAssertNotNil(app.store)
        XCTAssertNil(app.credentialAccessWarning)
    }

    func testLateConnectCompletionCannotReconnectParkedServer() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let catalogue = launch.makeModel(activeProfileKey: "catalogue")
        let profile = try catalogue.addRemoteProfile(name: "Slow", address: "https://compose.fixture.invalid")
        let latch = HubProbeLatch()
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: catalogue) { id in
            let app = launch.makeModel(activeProfileKey: "active.\(id)", persistsProfileCatalogue: false)
            app.credentialProbe = { _, _ in await latch.wait(); return StoredCredential(token: "test", tokenId: "test") }
            return app
        }
        let connection = Task { await hub.connect(profile) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting) && ContinuousClock.now < deadline { await Task.yield() }
        let waiting = await latch.waiting
        XCTAssertTrue(waiting)
        let outgoing = try XCTUnwrap(hub.models[profile.id])
        await hub.connect(profile)
        XCTAssertNil(outgoing.sheet)
        hub.disconnect(profile.id)
        await latch.release()
        await connection.value
        XCTAssertNil(outgoing.store); XCTAssertNil(outgoing.activeProfile)
        XCTAssertTrue(hub.connectedIDs.isEmpty)
    }
    func testActionsAndReadyFilterStayWithOwningServerAcrossDisconnect() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        let blocked = PreviewData.session(id: "s1", status: .init(known: .blocked))
        IOSMultiServerFixtureTransport.set([blocked], for: a.baseURL)
        IOSMultiServerFixtureTransport.set([blocked], for: b.baseURL)
        await hub.connect(a); await hub.connect(b)
        let first = try XCTUnwrap(hub.models[a.id]), second = try XCTUnwrap(hub.models[b.id])
        try await first.store?.refresh(); try await second.store?.refresh()
        let sidebarA = try XCTUnwrap(first.extension(SidebarModel.self))
        let sidebarB = try XCTUnwrap(second.extension(SidebarModel.self))
        sidebarA.reads = .stub
        sidebarB.reads = .stub
        sidebarB.reads.workingBlocked = { [:] }
        await sidebarA.refresh(); await sidebarB.refresh()
        let actionsA = try XCTUnwrap(first.extension(ActionsModel.self))
        let actionsB = try XCTUnwrap(second.extension(ActionsModel.self))
        XCTAssertTrue(actionsA.actions(for: blocked).contains(.stop))
        XCTAssertFalse(actionsB.actions(for: blocked).contains(.stop))
        let planA = try XCTUnwrap(first.extension(PlanModel.self))
        planA.receive(.unknown(name: "session:plangate-reviewing", payload: Data(#"{"id":"s1","reviewing":true}"#.utf8)))
        XCTAssertTrue(sidebarA.inReview(blocked))
        XCTAssertFalse(sidebarB.inReview(blocked))
        let herdA = try XCTUnwrap(first.extension(HerdSignals.self))
        herdA.applyForTesting(name: "session:git", payload: ["id": "s1", "git": ["state": "merged", "checks": "success", "deployConfigured": false]])
        var idle = blocked; idle.status = .init(known: .idle); idle.claudeSessionId = "claude-s1"
        XCTAssertFalse(actionsA.actions(for: idle).contains(.relaunch))
        XCTAssertTrue(actionsB.actions(for: idle).contains(.relaunch))
        hub.disconnect(b.id)
        XCTAssertTrue(actionsA.actions(for: blocked).contains(.stop))
        XCTAssertFalse(actionsA.actions(for: idle).contains(.relaunch))
        XCTAssertTrue(sidebarA.inReview(blocked))
    }

    func testComposerFallsBackToHealthyEmptyServerWhenFocusRequiresLogin() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a, login: true)
        hub.dismissSheet()
        await hub.connect(b)
        await settle { hub.models[b.id]?.store?.connection == .live }
        XCTAssertEqual(hub.focusedID, b.id)
        XCTAssertNil(hub.models[a.id]?.store)
        XCTAssertTrue(hub.models[b.id]?.store?.sessions.isEmpty == true)
        let target = IOSComposeTarget(hub: hub)
        XCTAssertEqual(target.profileID, b.id)
        let owner = try XCTUnwrap(target.model(in: hub))
        XCTAssertTrue(hub.openComposer())
        XCTAssertTrue(hub.routedSheet?.model === owner)
        XCTAssertEqual(owner.sheet, .newSession)
    }

    func testDisconnectParksLateLoginTokenWithoutReactivatingRetiredModel() async throws {
        let (launch, hub, a, _) = try fixture()
        await hub.connect(a, login: true)
        let app = try XCTUnwrap(hub.models[a.id])
        let latch = HubProbeLatch()
        app.login = { profile, _, credentials in
            await latch.wait()
            try credentials.save(.init(token: "parked", tokenId: "parked"), for: profile.credentialKey)
        }
        let login = Task { try await app.signIn(profile: a, password: "fixture") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        hub.disconnect(a.id)
        await latch.release()
        try await login.value
        XCTAssertNil(app.activeProfile)
        XCTAssertNil(app.store)
        XCTAssertEqual(try launch.credentials.load(for: a.credentialKey)?.tokenId, "parked")
    }

    func testLegacyNotificationOffersAvailableTargetWhileCredentialProbeStillChecksCollisions() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        let session = PreviewData.session(id: "same", status: .init(known: .running))
        IOSMultiServerFixtureTransport.set([session], for: a.baseURL)
        IOSMultiServerFixtureTransport.set([session], for: b.baseURL)
        await hub.connect(a)
        let store = try XCTUnwrap(hub.models[a.id]?.store)
        try await store.refresh()
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (!store.hasLoadedSessions || store.session(id: "same") == nil), ContinuousClock.now < deadline { await Task.yield() }
        await hub.connect(b, login: true)
        let peer = try XCTUnwrap(hub.models[b.id])
        peer.sheet = nil
        let latch = HubProbeLatch()
        peer.credentialProbe = { _, _ in await latch.wait(); return StoredCredential(token: "test", tokenId: "test") }
        let activation = Task { await peer.activate(b) }
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        let registration = IOSPushRegistration()
        registration.attach(hub, enabled: false)
        registration.open("same")
        XCTAssertNil(hub.selection)
        XCTAssertEqual(registration.notificationChoices, [.init(profileID: a.id, sessionID: "same")])
        await latch.release()
        await activation.value
        try await peer.store?.refresh()
        while peer.store?.hasLoadedSessions != true || peer.store?.session(id: "same") == nil {
            if ContinuousClock.now >= deadline { break }
            await Task.yield()
        }
        registration.routePendingNotification()
        XCTAssertEqual(registration.notificationChoices.count, 2)
        XCTAssertNil(hub.selection)
    }

    func testDisconnectInvalidatesLoginWithoutActiveProfileAndRemovalCleansLateToken() async throws {
        let (launch, hub, a, _) = try fixture()
        await hub.connect(a, login: true)
        let app = try XCTUnwrap(hub.models[a.id])
        let latch = HubProbeLatch()
        var revoked: [String] = []
        app.login = { profile, _, credentials in
            await latch.wait()
            try credentials.save(.init(token: "late", tokenId: "late"), for: profile.credentialKey)
        }
        app.logout = { profile, credentials in
            if let credential = try credentials.load(for: profile.credentialKey) { revoked.append(credential.tokenId) }
            try credentials.delete(for: profile.credentialKey)
        }
        let login = Task { try await app.signIn(profile: a, password: "fixture") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        let generation = app.activationGeneration
        hub.disconnect(a.id)
        XCTAssertGreaterThan(app.activationGeneration, generation)
        await hub.remove(a)
        await latch.release()
        try await login.value
        XCTAssertNil(app.activeProfile)
        XCTAssertNil(app.store)
        XCTAssertNil(try launch.credentials.load(for: a.credentialKey))
        XCTAssertTrue(revoked.contains("late"))
    }

    func testLateSignOutPreservesReplacementAndSerializesFreshLogin() async throws {
        let (launch, hub, a, _) = try fixture()
        defer { stop(hub) }
        await hub.connect(a)
        let old = try XCTUnwrap(hub.models[a.id])
        let latch = HubProbeLatch()
        old.logout = { profile, credentials in
            await latch.wait()
            try credentials.delete(for: profile.credentialKey)
        }
        let signOut = Task { await hub.signOutFocused() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        hub.disconnect(a.id)
        await hub.connect(a, login: true)
        let replacement = try XCTUnwrap(hub.models[a.id])
        var logins = 0
        replacement.login = { profile, _, credentials in
            logins += 1
            try credentials.save(.init(token: "fresh", tokenId: "fresh"), for: profile.credentialKey)
        }
        let login = Task { try await replacement.signIn(profile: a, password: "fixture") }
        // Drain the executor while the old revocation is explicitly held open.
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(logins, 0)
        await latch.release()
        await signOut.value
        try await login.value
        XCTAssertTrue(hub.models[a.id] === replacement)
        XCTAssertNotNil(replacement.store)
        XCTAssertEqual(try launch.credentials.load(for: a.credentialKey)?.tokenId, "fresh")
    }

    func testLateSignOutCannotDisconnectNewActivationOnSameModel() async throws {
        let (_, hub, a, _) = try fixture()
        defer { stop(hub) }
        await hub.connect(a)
        let app = try XCTUnwrap(hub.models[a.id])
        let latch = HubProbeLatch()
        app.logout = { _, _ in await latch.wait() }
        let signOut = Task { await hub.signOutFocused() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        await app.activate(a)
        let replacementStore = try XCTUnwrap(app.store)
        await latch.release()
        await signOut.value
        XCTAssertTrue(hub.models[a.id] === app)
        XCTAssertTrue(app.store === replacementStore)
        XCTAssertEqual(app.activeProfile, a)
    }

    func testCancelledLoginDoesNotBlockLegacyNotificationFromHealthyServer() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a)
        let store = try XCTUnwrap(hub.models[a.id]?.store)
        let session = PreviewData.session(id: "healthy", status: .init(known: .running))
        IOSMultiServerFixtureTransport.set([session], for: a.baseURL)
        try await store.refresh()
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (!store.hasLoadedSessions || store.session(id: "healthy") == nil), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotNil(store.session(id: "healthy"))
        await hub.connect(b, login: true)
        hub.models[b.id]?.sheet = nil
        let registration = IOSPushRegistration()
        registration.attach(hub, enabled: false)
        registration.open("healthy")
        XCTAssertEqual(hub.selection, .init(profileID: a.id, sessionID: "healthy"))
    }

}

private actor HubProbeLatch {
    private var continuation: CheckedContinuation<Void, Never>?
    var waiting: Bool { continuation != nil }
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}
