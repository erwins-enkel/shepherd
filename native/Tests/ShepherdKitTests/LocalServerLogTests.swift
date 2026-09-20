#if os(macOS)
import Testing

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
