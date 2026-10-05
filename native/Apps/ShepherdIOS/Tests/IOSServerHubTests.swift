import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSServerHubTests: XCTestCase {
    private func fixture() throws -> (IOSLaunchEnvironment, IOSServerHub, ServerProfile, ServerProfile) {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: launch.makeModel(activeProfileKey: "catalogue")) { id in
            let app = launch.makeModel(activeProfileKey: "active.\(id)", persistsProfileCatalogue: false)
            app.liveRequestAudit = nil
            return app
        }
        let run = UUID().uuidString.lowercased()
        let a = try hub.catalogue.addRemoteProfile(name: "Studio", address: "https://a-\(run).multi.fixture.invalid")
        let b = try hub.catalogue.addRemoteProfile(name: "Laptop", address: "https://b-\(run).multi.fixture.invalid")
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        for profile in [a, b] {
            try launch.credentials.save(.init(token: "fixture-token", tokenId: "fixture"), for: profile.credentialKey)
        }
        return (launch, hub, a, b)
    }
    private func stop(_ hub: IOSServerHub) { for id in hub.connectedIDs { hub.disconnect(id) } }

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

    func testLateConnectCompletionCannotReconnectParkedServer() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let catalogue = launch.makeModel(activeProfileKey: "catalogue")
        let profile = try catalogue.addRemoteProfile(name: "Slow", address: "https://compose.fixture.invalid")
        let latch = HubProbeLatch()
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: catalogue) { id in
            let app = launch.makeModel(activeProfileKey: "active.\(id)", persistsProfileCatalogue: false)
            app.credentialProbe = { _, _ in await latch.wait() }
            return app
        }
        let connection = Task { await hub.connect(profile) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !(await latch.waiting) && ContinuousClock.now < deadline { await Task.yield() }
        let waiting = await latch.waiting
        XCTAssertTrue(waiting)
        let outgoing = try XCTUnwrap(hub.models[profile.id])
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
        XCTAssertEqual(hub.focusedID, a.id)
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

    func testLegacyNotificationStillWaitsForAutomaticCredentialProbe() async throws {
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
        peer.credentialProbe = { _, _ in await latch.wait() }
        let activation = Task { await peer.activate(b) }
        while !(await latch.waiting), ContinuousClock.now < deadline { await Task.yield() }
        let registration = IOSPushRegistration()
        registration.attach(hub, enabled: false)
        registration.open("same")
        XCTAssertNil(hub.selection)
        XCTAssertTrue(registration.notificationChoices.isEmpty)
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
