import XCTest
import Foundation
import Synchronization
import SwiftUI
import ShepherdKit
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSRepoResolutionTests: XCTestCase {
    private func model() throws -> IOSRepoSettingsModel {
        let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://repo-resolution.fixture.invalid")!, mode: .remote)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RepoResolutionTransport.self]
        return IOSRepoSettingsModel(client: try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(),
            urlSession: URLSession(configuration: configuration)), slug: "owner/app")
    }

    func testOfflineLeaderSwitchUsesReachableWriterAndOnlyChangesLeader() async throws {
        RepoResolutionTransport.requests.withLock { $0 = [] }
        let model = try model()
        await model.load()
        XCTAssertEqual(model.project?.leitrechner?.reachable, false)
        XCTAssertEqual(model.writerID, "mac")
        XCTAssertNotEqual(model.reachability(try XCTUnwrap(model.project?.machines.last)), L.t("native_repo_offline"))
        model.selectedLeader = "linux"
        let unchanged = await model.saveLeader()
        XCTAssertFalse(unchanged)
        model.selectedLeader = "mac"
        let saved = await model.saveLeader()
        XCTAssertTrue(saved)
        let calls = RepoResolutionTransport.requests.withLock { $0 }
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.0, "mac")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(calls.first?.1)) as? [String: String])
        XCTAssertEqual(body, ["leitrechner": "mac"])
        XCTAssertEqual(model.receipt?.repoConfigCommit, "new-commit")
        XCTAssertNil(model.draft)
    }

    func testReferenceValueStillProducesCommitAndFailedWriteKeepsSelection() async throws {
        RepoResolutionTransport.requests.withLock { $0 = [] }
        let model = try model()
        await model.load()
        model.project?.leitrechner = nil
        model.project?.repoConfigCommit = nil
        let referenceConfig = model.project?.machines[0].config
        model.project?.machines[1].config = referenceConfig
        model.project?.machines[1].config?.criticEnabled = true
        model.beginMerge()
        model.merge?.selections["criticEnabled"] = "mac"
        XCTAssertTrue(model.merge?.ready == true)
        RepoResolutionTransport.failWrites.withLock { $0 = true }
        let failed = await model.saveMerge()
        RepoResolutionTransport.failWrites.withLock { $0 = false }
        XCTAssertFalse(failed)
        XCTAssertEqual(model.merge?.selections["criticEnabled"], "mac")
        XCTAssertNotNil(model.error)
        // Every chosen value equals the reference: a sparse draft would lose this initial save.
        let saved = await model.saveMerge()
        XCTAssertTrue(saved)
        let calls = RepoResolutionTransport.requests.withLock { $0 }
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(calls.last?.1)) as? [String: Any])
        let rules = try XCTUnwrap(body["rules"] as? [String: Any])
        XCTAssertEqual(rules["criticEnabled"] as? Bool, false)
        XCTAssertNil(rules["maxAuto"])
        XCTAssertNil(rules["leitrechner"])
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: XCTUnwrap(calls.first?.1)) as? NSDictionary,
                       try JSONSerialization.jsonObject(with: XCTUnwrap(calls.last?.1)) as? NSDictionary)
        XCTAssertNil(model.merge)
    }

    func testDifferenceStatusCountsFieldsOnceAcrossMachines() async throws {
        let model = try model()
        await model.load()
        model.project?.repoConfigCommit = nil
        model.project?.differences = try JSONDecoder().decode(Components.Schemas.RepoConfigDifferences.self, from: Data(
            #"{"applicable":true,"complete":true,"unavailableInstanceIds":[],"fields":[{"instanceId":"mac","fields":{"criticEnabled":false}},{"instanceId":"linux","fields":{"criticEnabled":true}}],"multipleAutoDrain":[]}"#.utf8))
        XCTAssertTrue(model.hasDifferences)
        XCTAssertEqual(IOSRepoSettingsModel.status(try XCTUnwrap(model.project)), L.t("native_repo_differences", "1"))
    }

    func testResolutionSheetsRenderAtPhoneWidth() async throws {
        let model = try model()
        await model.load()
        let referenceConfig = model.project?.machines[0].config
        model.project?.machines[1].config = referenceConfig
        model.project?.machines[1].config?.criticEnabled = true
        model.project?.machines[0].config?.autoDrainEnabled = true
        model.project?.machines[1].config?.autoDrainEnabled = true
        model.project?.differences.multipleAutoDrain = ["mac", "linux"]
        model.beginMerge()
        for merging in [true, false] {
            let size = CGSize(width: 390, height: 844)
            let host = UIHostingController(rootView: IOSRepoResolutionSheet(model: model, merging: merging))
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.rootViewController = host; window.isHidden = false
            defer { window.isHidden = true; window.rootViewController = nil }
            func ready(_ view: UIView) -> Bool {
                if let list = view as? UICollectionView { return !list.visibleCells.isEmpty }
                return view.subviews.contains(where: ready)
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while !ready(host.view), ContinuousClock.now < deadline {
                host.view.layoutIfNeeded(); await Task.yield()
            }
            XCTAssertTrue(ready(host.view))
            let image = UIGraphicsImageRenderer(size: size).image { _ in
                host.view.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = merging ? "merge-repository-rules" : "switch-offline-leitrechner"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

}

private final class RepoResolutionTransport: URLProtocol, @unchecked Sendable {
    static let requests = Mutex<[(String, Data)]>([])
    static let failWrites = Mutex(false)
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "repo-resolution.fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let rules = #"{"criticEnabled":false,"criticAllPrs":false,"criticSmellLensEnabled":false,"autoAddressEnabled":false,"autopilotEnabled":false,"planGateEnabled":false,"autoDrainEnabled":false,"autoMergeEnabled":false,"buildQueueEnabled":false,"draftMode":false,"signoffAuthority":"human","manualStepsIssueEnabled":false,"preWarmEpicLandingCi":false,"epicStacksEnabled":false,"autoLabel":"auto","defaultModel":"inherit","defaultEffort":"inherit"}"#
        let config = String(rules.dropLast()) + #", "fieldSources":{},"repoConfigCommit":"old","mergeWithoutCi":false,"sharedBrowserEnabled":false,"claudeAiConnectorsEnabled":false,"hidden":false,"pinned":false,"maxAuto":1,"usageCeilingPct":90,"sandboxProfile":"inherit","egressExtraHosts":[],"browserAllowedHosts":[],"repoMode":"github","previewOpenMode":"ask"}"#
        let json: String
        if request.httpMethod == "PUT" {
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    data.append(buffer, count: count)
                }
            }
            let writer = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "instanceId" }?.value ?? ""
            Self.requests.withLock { $0.append((writer, data)) }
            json = #"{"rules":\#(rules),"repoConfigCommit":"new-commit","leitrechner":"mac","notifications":[]}"#
        } else {
            json = #"{"remoteSlug":"owner/app","complete":false,"referenceInstanceId":"linux","rules":\#(rules),"repoConfigCommit":"old","leitrechner":{"instanceId":"linux","name":"Linux","reachable":false},"machines":[{"instanceId":"mac","name":"Mac","membership":"present","reachable":true,"reason":null,"config":\#(config)},{"instanceId":"linux","name":"Linux","membership":"present","reachable":false,"reason":"disconnected"}],"differences":{"applicable":false,"complete":false,"unavailableInstanceIds":["linux"],"fields":[],"multipleAutoDrain":[]}}"#
        }
        let failing = request.httpMethod == "PUT" && Self.failWrites.withLock { $0 }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: failing ? 502 : 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((failing ? #"{"error":"push failed","code":"repo_config_write_failed"}"# : json).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
