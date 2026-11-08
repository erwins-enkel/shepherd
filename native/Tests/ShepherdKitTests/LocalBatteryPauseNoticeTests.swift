#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.timeLimit(.minutes(1))) struct LocalBatteryPauseNoticeTests {
  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  @Test func theServerTakingTheNoticeAcknowledgesIt() async throws {
    let directory = try directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let notice = LocalBatteryPauseNotice(directory: directory)
    let server = Task {
      while !FileManager.default.fileExists(atPath: notice.url.path) {
        try await Task.sleep(for: .milliseconds(5))
      }
      try FileManager.default.removeItem(at: notice.url)
    }
    #expect(await notice.announce(timeout: .seconds(10)))
    try await server.value
  }

  @Test func aSilentServerTimesOutAndTheNoticeIsWithdrawn() async throws {
    let directory = try directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let notice = LocalBatteryPauseNotice(directory: directory)
    #expect(await notice.announce(timeout: .milliseconds(100)) == false)
    #expect(!FileManager.default.fileExists(atPath: notice.url.path))
  }

  @Test func aMissingDirectoryFailsWithoutWaiting() async {
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let notice = LocalBatteryPauseNotice(directory: missing)
    let started = ContinuousClock.now
    #expect(await notice.announce(timeout: .seconds(30)) == false)
    #expect(ContinuousClock.now - started < .seconds(5))
  }
}
#endif
