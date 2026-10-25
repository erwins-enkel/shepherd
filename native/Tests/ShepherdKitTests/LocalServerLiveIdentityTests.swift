#if os(macOS)
import Foundation
import Synchronization
import Testing
@testable import ShepherdKit

/// Whether the listener answers with the launch identity. A class, not a bare
/// `Mutex`: a noncopyable local cannot be captured by the escaping seam.
private final class Answers: Sendable {
  private let value = Mutex(true)
  var matches: Bool { value.withLock { $0 } }
  func set(_ matches: Bool) { value.withLock { $0 = matches } }
}

@Suite(.serialized, .timeLimit(.minutes(1))) struct LocalServerLiveIdentityTests {
  @Test func liveIdentityHoldsOnlyWhileTheRunningChildAnswersAsItself() async throws {
    let (launch, cleanup) = try fakeScript("while :; do sleep 0.1; done\n")
    defer { cleanup() }
    let answers = Answers()
    let sut = LocalServerSupervisor(environment: LocalServerEnvironment(home: launch.workingDirectory),
      identityHealth: { _ in answers.matches }, clock: TestClock(),
      runDirectory: launch.workingDirectory.appendingPathComponent("run"), launch: { launch })
    defer { sut.terminateNow(gracePeriod: 0) }

    #expect(await sut.verifyLiveIdentity() == false)
    await sut.start()
    #expect(await sut.state.isRunning)
    #expect(await sut.verifyLiveIdentity())

    // Something else answering the port does not match the launch identity.
    answers.set(false)
    #expect(await sut.verifyLiveIdentity() == false)

    answers.set(true)
    await sut.stop(gracePeriod: 0.3)
    #expect(await sut.verifyLiveIdentity() == false)
  }
}
#endif
