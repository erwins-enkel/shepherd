import XCTest
import ShepherdKit
@testable import ShepherdIOS

final class IOSLiveCleanupTests: XCTestCase {
    func testOwnedTokenHandoffIsPrivateAndStatusContainsNoSecret() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let handoff = directory.appendingPathComponent("handoff.json")
        let status = directory.appendingPathComponent("status.json")
        let cleanup = IOSLiveCleanup(runID: "unit-run", statusPath: status.path, handoffPath: handoff.path)
        try cleanup.record(.init(token: "fixture-only-token", tokenId: "fixture-id"),
            profile: .init(name: "Fixture", baseURL: URL(string: "http://127.0.0.1:7330")!, mode: .remote))
        let mode = try FileManager.default.attributesOfItem(atPath: handoff.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        let statusData = try Data(contentsOf: status)
        let evidence = try JSONDecoder().decode(IOSLiveCleanup.Status.self, from: statusData)
        XCTAssertEqual(evidence.runID, "unit-run")
        XCTAssertEqual(evidence.phase, "pending")
        XCTAssertFalse(String(decoding: statusData, as: UTF8.self).contains("fixture-only-token"))
    }
}
