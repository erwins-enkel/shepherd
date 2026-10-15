import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

/// The iOS composer with two connected servers (#2776): it submits through the server it is on
/// and leaves the machine to it. Automatic sends no machine from either server; an override names
/// one; a server the entry does not reach as a machine is still a Run on choice.
@MainActor
final class IOSRunOnTests: XCTestCase {
    private func fixture() throws -> (IOSLaunchEnvironment, IOSServerHub, ServerProfile, ServerProfile) {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: launch.makeModel(activeProfileKey: "catalogue")) { id in
            let app = launch.makeModel(activeProfileKey: "active.\(id)", persistsProfileCatalogue: false)
            app.liveRequestAudit = nil
            return app
        }
        let run = UUID().uuidString.lowercased()
        let a = try hub.catalogue.addRemoteProfile(name: "Linux", address: "https://a-\(run).multi.fixture.invalid")
        let b = try hub.catalogue.addRemoteProfile(name: "MacBook", address: "https://b-\(run).multi.fixture.invalid")
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        for profile in [a, b] {
            try launch.credentials.save(.init(token: "fixture-token", tokenId: "fixture"), for: profile.credentialKey)
        }
        return (launch, hub, a, b)
    }
    private func stop(_ hub: IOSServerHub) { for id in hub.connectedIDs { hub.disconnect(id) } }

    private static let linux = #"{"instanceId":"linux","name":"Linux","platform":"linux"}"#
    private static let mac = #"{"instanceId":"mac","name":"MacBook","platform":"macos"}"#

    /// What either server answers while they are connected to each other: both offered, itself
    /// first, the task placed by its requirements.
    private static func preview(first: String, second: String, target: String) -> String {
        #"""
        {"active":true,"deriveRequirements":true,"machines":[\#(first),\#(second)],
         "placement":{"mode":"auto","target":\#(target),"requirements":[],"basis":"preference","preferred":"linux",
          "by":{"instanceId":"x","name":"x"},"decidedAt":1}}
        """#
    }

    /// The preview and the create go over the fixture transport; the derivation is answered here,
    /// since the client's long-running session does not see a registered URLProtocol (its HTTP
    /// mapping is covered by `ShepherdClientPlacementTests`).
    private func composer(_ store: SessionStore, defaults: UserDefaults,
                          derived: [String] = []) -> ComposeModel {
        let client = store.client
        let answer = RequirementsDerivation(status: .init(value1: .derived, value2: "derived"),
                                           requirements: derived.map(Capability.init(id:)))
        let runOn = RunOnModel(reads: .init(preview: { try await client.previewPlacement($0) },
                                            derive: { _ in answer }))
        runOn.previewDelay = .zero
        runOn.deriveDelay = .zero
        return ComposeModel(defaults: defaults,
            repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: ["main"]) },
                loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true) },
                repair: { _, branch in .init(branch: branch) }),
            loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
            loadEpics: { _ in .init(epics: [], subIssues: []) }, runOn: runOn)
    }

    private func lastCreate(_ profile: ServerProfile) throws -> (json: [String: Any], key: String?) {
        let sent = try XCTUnwrap(IOSMultiServerFixtureTransport.created(at: profile.baseURL).last)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: sent.body) as? [String: Any])
        return (json, sent.key)
    }

    func testOptionsFollowTheServerTheTaskIsSubmittedTo() throws {
        let linux = try JSONDecoder().decode(SessionHost.self, from: Data(Self.linux.utf8))
        let mac = try JSONDecoder().decode(SessionHost.self, from: Data(Self.mac.utf8))
        let entry = IOSRunOnServer(profileID: UUID(), name: "Linux", instanceID: "linux")
        let laptop = IOSRunOnServer(profileID: UUID(), name: "MacBook", instanceID: "mac")
        let other = IOSRunOnServer(profileID: UUID(), name: "Box", instanceID: "box")
        let servers = IOSRunOnServers(entry: entry, others: [laptop, other], switchTo: { _, _ in })

        // The entry places tasks among machines: Automatic, its machines, and a server it does not
        // reach as a machine — never the same machine twice.
        XCTAssertEqual(IOSRunOnOption.options(active: true, machines: [linux, mac], servers: servers),
                       [.automatic, .machine(linux), .machine(mac), .server(other)])
        // Without the choice: the server picker it was.
        XCTAssertEqual(IOSRunOnOption.options(active: false, machines: [], servers: servers),
                       [.entry(entry), .server(laptop), .server(other)])
        // One server without machines: nothing to choose, the composer is as it was.
        XCTAssertTrue(IOSRunOnOption.options(active: false, machines: [], servers: nil).isEmpty)
        XCTAssertEqual(IOSRunOnOption.options(active: true, machines: [linux, mac], servers: nil).count, 3)
    }

    func testAutomaticSendsNoMachineFromEitherServerAndAnOverrideNamesOne() async throws {
        let (launch, hub, a, b) = try fixture()
        defer { stop(hub) }
        IOSMultiServerFixtureTransport.setPlacement(Self.preview(first: Self.linux, second: Self.mac, target: Self.mac), for: a.baseURL)
        IOSMultiServerFixtureTransport.setPlacement(Self.preview(first: Self.mac, second: Self.linux, target: Self.mac), for: b.baseURL)
        await hub.connect(a); await hub.connect(b)
        for (profile, other) in [(a, "mac"), (b, "linux")] {
            let store = try XCTUnwrap(hub.models[profile.id]?.store)
            let tasks: [(String, [String])] = [("Fix the iOS build in Xcode", ["xcode"]), ("Restyle the web settings page", [])]
            for (prompt, derived) in tasks {
                let compose = composer(store, defaults: launch.defaults, derived: derived)
                compose.repoPath = "/fixtures/shepherd"; compose.prompt = prompt
                await compose.refreshPlacement()
                await compose.deriveRequirements()
                XCTAssertTrue(compose.runOn.active)
                XCTAssertTrue(compose.readiness().canSubmit, compose.readiness().copy)
                let submission = ComposeSubmission()
                _ = await submission.submit(model: compose, repoResolved: true, holdLikely: false,
                    send: { try await store.client.createSession($0, spawnID: $1.spawnID, idempotencyKey: $1.idempotencyKey) },
                    isCurrent: { true })
                let sent = try lastCreate(profile)
                XCTAssertNil(sent.json["target"], "Automatic leaves the machine to \(profile.name)")
                XCTAssertEqual(sent.json["requirements"] as? [String], derived.isEmpty ? nil : derived)
                XCTAssertNotNil(sent.key, "every create is keyed while the choice is active")
                submission.teardown(); compose.teardown()
            }

            let compose = composer(store, defaults: launch.defaults)
            compose.repoPath = "/fixtures/shepherd"; compose.prompt = "Fix the iOS build in Xcode"
            compose.runOn.pick = other
            await compose.refreshPlacement()
            let submission = ComposeSubmission()
            _ = await submission.submit(model: compose, repoResolved: true, holdLikely: false,
                send: { try await store.client.createSession($0, spawnID: $1.spawnID, idempotencyKey: $1.idempotencyKey) },
                isCurrent: { true })
            XCTAssertEqual((try lastCreate(profile).json["target"] as? [String: Any])?["instanceId"] as? String, other)
            submission.teardown(); compose.teardown()
        }
    }

    func testAServerChoiceMovesTheComposerAndTakesThePickAlong() async throws {
        let (_, hub, a, b) = try fixture()
        defer { stop(hub) }
        await hub.connect(a); await hub.connect(b)
        hub.focus(a.id)
        let target = IOSComposeTarget(hub: hub)
        XCTAssertEqual(target.profileID, a.id)
        let carry = IOSRunOnCarry(pick: "mac", requirements: ["xcode"], touched: true)
        let servers = IOSRunOnServers(entry: .init(profileID: a.id, name: a.name, instanceID: nil),
                                      others: [.init(profileID: b.id, name: b.name, instanceID: "mac")],
                                      switchTo: { next, carried in target.runOn = carried; target.select(next.profileID, hub: hub) })
        servers.switchTo(servers.others[0], carry)
        XCTAssertEqual(target.profileID, b.id)
        XCTAssertEqual(target.runOn, carry)

        // The composer on the other server starts with the pick and the operator's chips.
        let store = try XCTUnwrap(hub.models[b.id]?.store)
        let compose = composer(store, defaults: UserDefaults(suiteName: "IOSRunOnTests.\(UUID())")!)
        defer { compose.teardown() }
        compose.runOn.restore(pick: carry.pick, requirements: carry.requirements, touched: carry.touched)
        XCTAssertEqual(compose.runOn.pick, "mac")
        XCTAssertEqual(compose.runOn.requirements, ["xcode"])
        XCTAssertTrue(compose.runOn.requirementsTouched)
    }
}
