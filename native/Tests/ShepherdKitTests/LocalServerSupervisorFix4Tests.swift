#if os(macOS)
import Foundation
import Synchronization
import Testing

@testable import ShepherdKit

/// Regression tests for the final whole-branch review (C1, I1, I4).
///
/// The theme is that a pipe is not a process. Death used to be detected only by
/// the output pipe reaching EOF, which is wrong in both directions — a child can
/// close its stdio and keep running, and a child's own descendants hold the
/// write end open long after the child itself is gone — and the same confusion
/// between "the leader" and "the group" let descendants survive a teardown.
@Suite(.serialized, .timeLimit(.minutes(1))) struct LocalServerSupervisorFix4Tests {
  private func supervisor(
    _ launch: LocalServerLaunch, health: @escaping @Sendable () async -> Bool,
    clock: any SupervisorClock = TestClock(),
    policy: LocalServerSupervisor.RestartPolicy = .init()
  ) -> LocalServerSupervisor {
    LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(capacity: 200), health: health, clock: clock, policy: policy,
      launch: { launch })
  }

  /// C1a. EOF is not exit. A child that closes its stdio and keeps running used
  /// to reach `childStreamEnded`, wait out `exitCode()`'s fixed 25×20 ms budget,
  /// settle for `-1`, clear `livePID`/`process` and spawn a replacement — so the
  /// first child became invisible to `stop()` *and* to `terminateNow()` and
  /// survived app quit forever.
  @Test func aChildThatClosesItsStdioIsNotDeclaredDead() async throws {
    let (launch, cleanup) = try fakeScript(
      """
      echo 'alive'
      exec 1>&-
      exec 2>&-
      sleep 30
      """)
    defer { cleanup() }
    let sut = supervisor(launch, health: { true })
    await sut.start()
    let pid = try #require(await sut.state.pid)
    try await waitUntil { await sut.logLines().contains("alive") }
    // Well past the old 500 ms `exitCode()` budget the EOF path used to spend
    // before declaring the child dead.
    try await Task.sleep(for: .milliseconds(800))

    #expect(await sut.state.pid == pid)  // still the same child
    #expect(processIsAlive(pid))
    #expect(processCommandCount(containing: launch.arguments[0]) == 1)  // no replacement

    await sut.stop(gracePeriod: 0.5)
    #expect(!processIsAlive(pid))
    try await waitUntil { processCommandCount(containing: launch.arguments[0]) == 0 }
  }

  /// C1b. Exit is not EOF. The real server spawns agents, git and bun workers
  /// that inherit the pipe's write end, so EOF arrives long after the child died
  /// — or never. Driving the lifecycle off the pipe meant the crash/backoff/
  /// crash-loop policy never fired at all for exactly the descendant processes
  /// the rest of the supervisor goes to lengths about.
  @Test func anExitWhoseGrandchildHoldsThePipeIsStillNoticedAndRestarted() async throws {
    let (launch, cleanup) = try fakeScript(
      """
      if [ -f ran ]; then
        echo 'replacement is up'
        sleep 30
      else
        : > ran
        sleep 30 &
        echo "holder=$!"
        echo 'first child is up'
        while [ ! -f release-first ]; do sleep 0.01; done
        exit 3
      fi
      """)
    defer { cleanup() }
    let clock = TestClock()
    let sut = supervisor(launch, health: { true }, clock: clock)
    // The file barrier must not leave a child parked if an earlier require fails.
    defer { sut.terminateNow(gracePeriod: 0) }
    await sut.start()
    let first = try #require(await sut.state.pid)
    try await waitUntil { await sut.logLines().contains("first child is up") }
    let holderLine = try #require(await sut.logLines().first { $0.hasPrefix("holder=") })
    let holder = try #require(Int32(holderLine.dropFirst("holder=".count)))
    defer { kill(holder, SIGKILL) }

    // Release only after observing the original PID and the pipe holder.
    try Data().write(to: launch.workingDirectory.appendingPathComponent("release-first"))

    // The child is gone but its `sleep` still owns the write end, so no EOF is
    // coming before the assertion's deadline. The exit itself has to be what the
    // supervisor acts on — the short timeout is the assertion.
    try await waitUntil(timeout: 3) { await sut.logLines().contains("replacement is up") }
    #expect(kill(holder, 0) == 0)  // and it really was still holding the pipe
    let second = try #require(await sut.state.pid)
    #expect(second != first)
    #expect(!processIsAlive(first))
    #expect(await clock.slept.contains(1))  // the crash backoff really ran

    await sut.stop(gracePeriod: 0.5)
    try await waitUntil { processCommandCount(containing: launch.arguments[0]) == 0 }
  }

  /// I1. SIGTERM goes to the process *group*, but the grace loop and the
  /// escalation both tested only the leader's pid: the moment the leader died
  /// the loop exited, `kill(pid, 0) != 0`, and SIGKILL was never sent — so a
  /// descendant that ignored SIGTERM outlived the app.
  @Test func stopEscalatesToSIGKILLForGroupMembersThatIgnoredSIGTERM() async throws {
    let (launch, cleanup) = try fakeScript(
      """
      /bin/sh -c 'trap "" TERM; i=0; while [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done' &
      sleep 60
      """)
    defer { cleanup() }
    let sut = supervisor(launch, health: { true })
    await sut.start()
    let pid = try #require(await sut.state.pid)
    let group = getpgid(pid)
    #expect(group == pid)  // `Process` gives each child a group of its own
    try await waitUntil { processesInGroup(group).count >= 2 }

    await sut.stop(gracePeriod: 0.3)

    #expect(!processIsAlive(pid))
    try await waitUntil { processesInGroup(group).isEmpty }
  }

  /// I4a. `BootLineScanner` needs the whole `Operator password (shown ONCE): `
  /// prefix inside one "line", but the pump force-flushes at
  /// `maxPartialLineBytes`. A banner sitting across that boundary used to be
  /// missed entirely — nothing captured, and the secret left in the ring in
  /// clear text for the panel's log disclosure to show.
  @Test func aPasswordSplitByTheForcedFlushIsStillCapturedAndRedacted() async throws {
    let password = "Zx9_bigline-password-abcdefgh"
    // 65520 filler bytes put the 64 KiB flush boundary in the middle of the
    // banner that follows, without a newline anywhere before it.
    let (launch, cleanup) = try fakeScript(
      """
      head -c 65520 /dev/zero | tr '\\0' x
      printf '  Operator password (shown ONCE): \(password)\\n'
      echo 'shepherd core on http://localhost:7330'
      sleep 30
      """)
    defer { cleanup() }
    let sut = supervisor(launch, health: { true })
    await sut.start()
    try await waitUntil(timeout: 10) {
      let captured = await sut.capturedPassword == password
      let redacted = await sut.logLines().contains { $0.contains(LogRing.placeholder) }
      return captured && redacted
    }
    let lines = await sut.logLines()
    #expect(lines.allSatisfy { !$0.contains(password) })
    #expect(lines.contains { $0.contains(LogRing.placeholder) })
    await sut.stop(gracePeriod: 0.5)
  }

  /// I4b. The other splitter is the bounded buffering policy: when chunks are
  /// dropped the pump puts a `dropMarker` between the fragment that ended at
  /// the hole and the one that resumes after it, so the banner and the secret
  /// arrive as two lines with a third one in between. Provoking a real drop
  /// needs a 4096-chunk overflow, so the fragments go through the scanner
  /// directly.
  @Test func aPasswordSeparatedFromItsBannerByADropMarkerIsStillCaptured() async throws {
    let password = "Zx9_drop-password-abcdefgh"
    let home = URL(fileURLWithPath: NSTemporaryDirectory())
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: home), log: LogRing(capacity: 50),
      health: { false }, clock: TestClock(), launch: { nil })

    await sut.ingestForTesting("shepherd core on http://localhost:7330")
    await sut.ingestForTesting("  Operator password (shown ONCE): ")
    await sut.ingestForTesting(ProcessOutputPump.dropMarker(3))
    await sut.ingestForTesting("\(password) — keep it somewhere safe")

    #expect(await sut.capturedPassword == password)
    #expect(await sut.logLines().allSatisfy { !$0.contains(password) })
  }
}
#endif
