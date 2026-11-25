import XCTest
import Foundation
import SwiftUI
import ShepherdKit
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSRepoSettingsTests: XCTestCase {
    private func project(commit: String? = nil) throws -> RepoConfigProject {
        let rules: [String: Any] = ["criticEnabled": false, "criticAllPrs": false, "criticSmellLensEnabled": false,
            "autoAddressEnabled": false, "autopilotEnabled": false, "planGateEnabled": false, "autoDrainEnabled": false,
            "autoMergeEnabled": false, "buildQueueEnabled": false, "draftMode": false, "signoffAuthority": "either",
            "manualStepsIssueEnabled": false, "preWarmEpicLandingCi": false, "epicStacksEnabled": false,
            "claudeShipStewardDefer": false, "autoLabel": "shepherd", "defaultModel": "inherit", "defaultEffort": "inherit"]
        var config = rules
        config.merge(["fieldSources": [:], "repoConfigCommit": commit as Any? ?? NSNull(),
            "epicClaimAutoRelease": false, "mergeWithoutCi": false,
            "sharedBrowserEnabled": false, "claudeAiConnectorsEnabled": false, "hidden": false, "pinned": false,
            "maxAuto": 1, "usageCeilingPct": 90, "sandboxProfile": "inherit", "egressExtraHosts": [],
            "browserAllowedHosts": [], "repoMode": "github", "previewOpenMode": "ask"]) { $1 }
        let json: [String: Any] = ["remoteSlug": "owner/app", "complete": false, "referenceInstanceId": "mac",
            "rules": rules, "repoConfigCommit": commit as Any? ?? NSNull(), "leitrechner": NSNull(),
            "machines": [
                ["instanceId": "mac", "name": "MacBook", "membership": "present", "reachable": true, "reason": NSNull(), "config": config],
                ["instanceId": "linux", "name": "Linux", "membership": "present", "reachable": false, "reason": "disconnected", "config": NSNull()]],
            "differences": ["applicable": true, "complete": false, "unavailableInstanceIds": ["linux"], "fields": [], "multipleAutoDrain": []]]
        return try JSONDecoder().decode(RepoConfigProject.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testOfflinePeerDoesNotBlockWriterAndDraftStaysLocal() throws {
        let profile = ServerProfile(name: "fixture", baseURL: URL(string: "http://localhost:8080")!, mode: .local)
        let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
        let model = IOSRepoSettingsModel(client: client, slug: "owner/app")
        model.project = try project()
        model.draft = RepoProjectDraft(rules: try XCTUnwrap(model.project?.rules), leader: nil)
        model.draft?.rules.criticEnabled = true
        model.draft?.rules.planGateEnabled = true
        XCTAssertEqual(model.changes.count, 2)
        XCTAssertEqual(model.writerID, "mac")
        XCTAssertEqual(model.project?.machines.last?.reachable, false)
        XCTAssertEqual(model.project?.rules?.criticEnabled, false)
        model.machineID = "linux"
        XCTAssertNil(model.machine?.config)
        XCTAssertEqual(IOSRepoSettingsModel.status(try project(commit: "abc")), L.t("native_repo_rules_shared"))
        model.project?.machines[0].config?.repoMode = "lightweight"
        XCTAssertTrue(model.isLocalOnly)
        XCTAssertEqual(IOSRepoSettingsModel.status(try XCTUnwrap(model.project)), L.t("native_repo_local_only"))
    }

    func testSettingsFormRendersWithOfflinePeer() async throws {
        let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://settings.multi.fixture.invalid")!, mode: .remote)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [IOSMultiServerFixtureTransport.self]
        let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(),
            urlSession: URLSession(configuration: configuration))
        let model = IOSRepoSettingsModel(client: client, slug: "owner/app")
        model.project = try project()
        model.draft = RepoProjectDraft(rules: try XCTUnwrap(model.project?.rules), leader: nil)
        let size = CGSize(width: 390, height: 844)
        let host = UIHostingController(rootView: NavigationStack {
            IOSRepoSettingsView(model: model)
        }.preferredColorScheme(.dark))
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host; window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil }
        func ready(_ view: UIView) -> Bool {
            if let list = view as? UICollectionView { return !list.visibleCells.isEmpty }
            return view.subviews.contains(where: ready)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !ready(host.view), ContinuousClock.now < deadline {
            host.view.layoutIfNeeded()
            await Task.yield()
        }
        XCTAssertTrue(ready(host.view))
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            host.view.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "repo-settings-offline-peer"; attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSameNameReposKeepDistinctSettingsTargetsAndOneCoordinatorPerSlug() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(defaults: launch.defaults, catalogue: launch.makeModel(activeProfileKey: "catalogue")) {
            launch.makeModel(activeProfileKey: "active.\($0)", persistsProfileCatalogue: false)
        }
        defer { for id in hub.connectedIDs { hub.disconnect(id) } }
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let run = UUID().uuidString.lowercased()
        let a = try hub.catalogue.addRemoteProfile(name: "Mac", address: "https://a-\(run).multi.fixture.invalid")
        let b = try hub.catalogue.addRemoteProfile(name: "Linux", address: "https://b-\(run).multi.fixture.invalid")
        for profile in [a, b] {
            try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        }
        IOSMultiServerFixtureTransport.setRepos(#"[{"name":"app","path":"/a/app","display":"app","realPath":"/a/app","isFork":false,"hidden":false,"remoteSlug":"owner/app"},{"name":"app","path":"/b/app","display":"app","realPath":"/b/app","isFork":false,"hidden":false,"remoteSlug":"other/app"}]"#, for: a.baseURL)
        IOSMultiServerFixtureTransport.setRepos(#"[{"name":"app","path":"/linux/app","display":"app","realPath":"/linux/app","isFork":false,"hidden":false,"remoteSlug":"owner/app"}]"#, for: b.baseURL)
        await hub.connect(a); await hub.connect(b)
        for app in hub.connected { try await app.store?.bootstrap() }
        let chip = IOSMergedSessionPresentation.Chip(name: "app", paths: ["/a/app", "/b/app", "/linux/app"], count: 3)
        let targets = IOSRepoSettingsTarget.targets(chip: chip, hub: hub)
        XCTAssertEqual(targets.count, 2)
        XCTAssertEqual(Set(targets.compactMap(\.slug)), ["owner/app", "other/app"])
        XCTAssertEqual(targets.filter { $0.slug == "owner/app" }.count, 1)
        hub.toggleRepo(chip.paths)
        XCTAssertEqual(hub.selectedRepos, chip.paths)
    }

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
        // Activation starts the store; these tests inject their reads and writes, so no second bootstrap is needed.
        _ = try XCTUnwrap(owner.store)
        // All writes are injected; production isolated launches retain their audit.
        owner.liveRequestAudit = nil
        return (hub, owner, profile)
    }

    private func config(_ overrides: [String: Any] = [:]) throws -> RepoConfig {
        var json: [String: Any] = [
            "fieldSources": [String: String](), "repoConfigCommit": NSNull(),
            "criticEnabled": false, "criticAllPrs": false, "criticSmellLensEnabled": false,
            "autoAddressEnabled": false, "autopilotEnabled": false, "planGateEnabled": false,
            "autoDrainEnabled": false, "autoMergeEnabled": false, "buildQueueEnabled": false,
            "draftMode": false, "manualStepsIssueEnabled": false, "preWarmEpicLandingCi": false,
            "epicClaimAutoRelease": false,
            "mergeWithoutCi": false, "epicStacksEnabled": false, "claudeShipStewardDefer": false,
            "sharedBrowserEnabled": false,
            "claudeAiConnectorsEnabled": false, "hidden": false, "pinned": false,
            "signoffAuthority": "either", "maxAuto": 1, "autoLabel": "shepherd", "usageCeilingPct": 90,
            "sandboxProfile": "inherit", "defaultModel": "inherit", "defaultEffort": "inherit",
            "egressExtraHosts": [String](), "browserAllowedHosts": [String](), "repoMode": "github", "previewOpenMode": "ask",
        ]
        json.merge(overrides) { $1 }
        return try JSONDecoder().decode(RepoConfig.self, from: JSONSerialization.data(withJSONObject: json))
    }
}
