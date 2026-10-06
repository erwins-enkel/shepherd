#if os(macOS)
import Testing
import Foundation

@testable import ShepherdKit

@Suite(.timeLimit(.minutes(1))) struct BootLineScannerTests {
  @Test func theReadyLineYieldsItsPort() {
    #expect(BootLineScanner.readyPort(in: "shepherd core on http://localhost:7330") == 7330)
    #expect(BootLineScanner.readyPort(in: "shepherd core on http://localhost:7331") == 7331)
    #expect(BootLineScanner.readyPort(in: "loaded 12 sessions") == nil)
    #expect(BootLineScanner.readyPort(in: "shepherd core on http://localhost:") == nil)
  }

  /// A configured password prints no banner; a line that merely mentions the
  /// phrase must not be mistaken for one.
  @Test func onlyTheFullBannerYieldsAPassword() {
    #expect(
      BootLineScanner.generatedPassword(
        in: "  Operator password (shown ONCE): aB3-_xyz01234567890abcd") == "aB3-_xyz01234567890abcd")
    #expect(BootLineScanner.generatedPassword(in: "CHANGE THIS: set SHEPHERD_PASSWORD") == nil)
    #expect(BootLineScanner.generatedPassword(in: "Operator password (shown ONCE):") == nil)
  }
}

@Suite(.serialized, .timeLimit(.minutes(1))) struct PersistentServerLogTests {
  @Test func tailRewindsAfterTruncationAndFollowsAReplacedFile() async throws {
    let (launch, cleanup) = try fakeScript("exit 0\n")
    defer { cleanup() }
    let url = launch.workingDirectory.appendingPathComponent("tail.log")
    try Data("first long line\n".utf8).write(to: url)
    let ring = LogRing()
    let tail = Task { await LocalServerLogTail.run(url) { await ring.append($0) } }
    defer { tail.cancel() }
    try await waitUntil { await ring.lines.contains("first long line") }
    let fd = open(url.path, O_WRONLY | O_APPEND)
    #expect(fd >= 0)
    let writer = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? writer.close() }
    try writer.truncate(atOffset: 0)
    try await Task.sleep(for: .milliseconds(150))
    try writer.write(contentsOf: Data("next\n".utf8))
    try await waitUntil { await ring.lines.contains("next") }
    try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("old"))
    try Data("replacement\n".utf8).write(to: url)
    try await waitUntil { await ring.lines.contains("replacement") }
    tail.cancel()
    await tail.value
  }

  @Test func copyTruncateKeepsAnAppendWriterUsableAndCapsThePreviousCopy() throws {
    let (launch, cleanup) = try fakeScript("exit 0\n")
    defer { cleanup() }
    let url = launch.workingDirectory.appendingPathComponent("bounded.log")
    let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_EXCL, 0o600)
    #expect(fd >= 0)
    let writer = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? writer.close() }
    try writer.write(contentsOf: Data("discard-prefix-last-ten-bytes".utf8))
    LocalServerLogTail.maintain(url, limit: 10)
    #expect(try Data(contentsOf: url).isEmpty)
    #expect(try Data(contentsOf: URL(fileURLWithPath: url.path + ".1")).count == 10)
    try writer.write(contentsOf: Data("after\n".utf8))
    #expect(try String(contentsOf: url, encoding: .utf8) == "after\n")
    let attrs = try FileManager.default.attributesOfItem(atPath: url.path + ".1")
    #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
  }
}

@Suite(.timeLimit(.minutes(1))) struct LogRingTests {
  @Test func theRingKeepsOnlyTheLastNLinesAndClears() async {
    let ring = LogRing(capacity: 3)
    for index in 1...5 { await ring.append("line \(index)") }
    #expect(await ring.lines == ["line 3", "line 4", "line 5"])
    await ring.clear()
    #expect(await ring.lines.isEmpty)
  }

  /// The whole point: once captured, the password must be gone from what the
  /// operator can open AND from anything appended afterwards.
  @Test func redactionScrubsPastAndFutureLines() async {
    let ring = LogRing(capacity: 10)
    await ring.append("Operator password (shown ONCE): s3cr3t-token-value-abcd")
    await ring.redact("s3cr3t-token-value-abcd")
    await ring.append("retrying login with s3cr3t-token-value-abcd")
    let lines = await ring.lines
    #expect(lines.allSatisfy { !$0.contains("s3cr3t-token-value-abcd") })
    #expect(lines[0].contains(LogRing.placeholder))
    #expect(lines[1] == "retrying login with \(LogRing.placeholder)")
  }

  @Test func redactingAnEmptySecretIsANoOp() async {
    let ring = LogRing(capacity: 10)
    await ring.append("hello")
    await ring.redact("")
    #expect(await ring.lines == ["hello"])
  }
}
#endif
