import XCTest
import ShepherdKit
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSRepoSettingsTests: XCTestCase {
    func testPresetWritesOnceToOwningRepoAndAdoptsServerResponse() async throws {
        let (hub, owner, profile) = try await context()
        defer { hub.disconnect(profile.id) }
        let initial = try config(), updated = try config(["criticEnabled": true, "autoAddressEnabled": true,
            "autopilotEnabled": true, "autoDrainEnabled": true, "autoMergeEnabled": true])
        var writes: [(String, RepoConfigPatch)] = []
        let control = IOSRepoSettingsControl(owner: owner, path: "/repos/calendar", read: { _, path in
            XCTAssertEqual(path, "/repos/calendar"); return initial
        }, write: { _, path, patch in writes.append((path, patch)); return updated })
        await control.load()
        await control.select(.full)
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.0, "/repos/calendar")
        let patch = try XCTUnwrap(writes.first?.1)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Bool])
        XCTAssertEqual(body, ["criticEnabled": true, "autoAddressEnabled": true, "autopilotEnabled": true,
                              "autoDrainEnabled": true, "autoMergeEnabled": true, "draftMode": false])
        XCTAssertEqual(control.config, updated)
        XCTAssertNotNil(control.summary)
        XCTAssertFalse(control.busy)
    }

    func testFailureRetainsSelectionAndReadOnlyRejectsWrites() async throws {
        let (hub, owner, profile) = try await context()
        defer { hub.disconnect(profile.id) }
        let initial = try config()
        var writes = 0
        let control = IOSRepoSettingsControl(owner: owner, path: "/repos/calendar", read: { _, _ in initial },
            write: { _, _, _ in writes += 1; throw URLError(.notConnectedToInternet) })
        await control.load()
        await control.select(.full)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(control.config, initial)
        XCTAssertNotNil(control.error)
        XCTAssertFalse(control.busy)
        owner.liveRequestAudit = ReadOnlyRequestAudit()
        await control.select(.review)
        XCTAssertEqual(writes, 1)
        XCTAssertFalse(control.writable)
    }

    func testLocalOnlyRepoRejectsForgePresets() async throws {
        let (hub, owner, profile) = try await context()
        defer { hub.disconnect(profile.id) }
        let local = try config(["repoMode": "lightweight"])
        var writes = 0
        let control = IOSRepoSettingsControl(owner: owner, path: "/local", read: { _, _ in local },
            write: { _, _, _ in writes += 1; return local })
        await control.load()
        await control.select(.backlog)
        await control.select(.full)
        XCTAssertEqual(writes, 0)
        await control.select(.review)
        XCTAssertEqual(writes, 1)
    }

    func testDeactivationRejectsLateReadAndFutureWrites() async throws {
        let (hub, owner, profile) = try await context()
        defer { hub.disconnect(profile.id) }
        let initial = try config()
        var continuation: CheckedContinuation<RepoConfig, Never>?
        var writes = 0
        let control = IOSRepoSettingsControl(owner: owner, path: "/repos/calendar", read: { _, _ in
            await withCheckedContinuation { continuation = $0 }
        }, write: { _, _, _ in writes += 1; return initial })
        let loading = Task { await control.load() }
        while continuation == nil { await Task.yield() }
        owner.deactivate()
        continuation?.resume(returning: initial)
        await loading.value
        XCTAssertNil(control.config)
        XCTAssertFalse(control.current)
        await control.select(.full)
        XCTAssertEqual(writes, 0)
    }

    func testDuplicateTapsAndLateSaveAfterDisconnectAreIgnored() async throws {
        let (hub, owner, profile) = try await context()
        defer { hub.disconnect(profile.id) }
        let initial = try config(), updated = try config(["criticEnabled": true])
        var continuation: CheckedContinuation<RepoConfig, Never>?
        var writes = 0
        let control = IOSRepoSettingsControl(owner: owner, path: "/repos/calendar", read: { _, _ in initial },
            write: { _, _, _ in
                writes += 1
                return await withCheckedContinuation { continuation = $0 }
            })
        await control.load()
        let saving = Task { await control.select(.review) }
        while continuation == nil { await Task.yield() }
        await control.select(.full)
        XCTAssertEqual(writes, 1)
        owner.deactivate()
        continuation?.resume(returning: updated)
        await saving.value
        XCTAssertEqual(control.config, initial)
        XCTAssertFalse(control.busy)
        await control.select(.full)
        XCTAssertEqual(writes, 1)
    }

    func testLoadCanRetryAndHintsFollowEffectiveConfig() async throws {
        let (hub, owner, profile) = try await context()
        defer { hub.disconnect(profile.id) }
        let initial = try config(["autoDrainEnabled": true, "sandboxDefaultProfile": "standard", "noPrCi": true])
        var reads = 0
        let control = IOSRepoSettingsControl(owner: owner, path: "/repos/calendar", read: { _, _ in
            reads += 1
            if reads == 1 { throw URLError(.notConnectedToInternet) }
            return initial
        })
        await control.load()
        XCTAssertNil(control.config)
        XCTAssertNotNil(control.error)
        await control.load()
        XCTAssertEqual(control.config, initial)
        XCTAssertNil(control.error)
        XCTAssertEqual(control.hints.count, 2)
    }

    private func context() async throws -> (IOSServerHub, AppModel, ServerProfile) {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let profile = try hub.catalogue.addRemoteProfile(name: "Repo settings", address: "https://repos-\(UUID().uuidString).multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        IOSMultiServerFixtureTransport.set([], for: profile.baseURL)
        await hub.connect(profile)
        let owner = try XCTUnwrap(hub.models[profile.id])
        try await owner.store?.bootstrap()
        // All writes are injected; production isolated launches retain their audit.
        owner.liveRequestAudit = nil
        return (hub, owner, profile)
    }

    private func config(_ overrides: [String: Any] = [:]) throws -> RepoConfig {
        var json: [String: Any] = [
            "criticEnabled": false, "criticAllPrs": false, "criticSmellLensEnabled": false,
            "autoAddressEnabled": false, "autopilotEnabled": false, "planGateEnabled": false,
            "autoDrainEnabled": false, "autoMergeEnabled": false, "buildQueueEnabled": false,
            "draftMode": false, "manualStepsIssueEnabled": false, "preWarmEpicLandingCi": false,
            "mergeWithoutCi": false, "epicStacksEnabled": false, "sharedBrowserEnabled": false,
            "claudeAiConnectorsEnabled": false, "hidden": false, "pinned": false,
            "signoffAuthority": "either", "maxAuto": 1, "autoLabel": "shepherd", "usageCeilingPct": 90,
            "sandboxProfile": "inherit", "defaultModel": "inherit", "defaultEffort": "inherit",
            "egressExtraHosts": [String](), "browserAllowedHosts": [String](), "repoMode": "github", "previewOpenMode": "ask",
        ]
        json.merge(overrides) { $1 }
        return try JSONDecoder().decode(RepoConfig.self, from: JSONSerialization.data(withJSONObject: json))
    }
}
