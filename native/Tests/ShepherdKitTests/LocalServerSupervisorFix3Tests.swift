#if os(macOS)
import Foundation
import Synchronization
import Testing

@testable import ShepherdKit

/// A gate a test opens by hand. `GatedTestClock` parks on a *duration*; this
/// parks on a seam that has none — the health probe, or one line of pumped
/// output — so a supervisor call can be held at an exact point and the
/// lifecycle gate kept open for as long as the test needs.
actor ProbeGate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private(set) var waitCount = 0

  func wait() async {
    if isOpen { return }
    waitCount += 1
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    let parked = waiters
    waiters.removeAll()
    for waiter in parked { waiter.resume() }
  }
}

/// Regression tests for the coordinator's third review pass: a crash-loop
/// relaunch that spawned into a world its own child no longer belonged to, a
/// quit that an in-flight `restart()` spawned straight past, output chunks the
/// buffering policy dropped without a trace, and the pump's final flush.
@Suite(.serialized) struct LocalServerSupervisorFix3Tests {
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

  /// BL. The crash loop's `relaunch()` parks on the lifecycle gate like every
  /// other spawn path — and parking is a suspension like any other. An
  /// operator's `restart()` can take the gate first, stop the crashed child,
  /// spawn its own replacement and finish while the relaunch waits; resuming
  /// then and spawning anyway leaves that replacement alive and unowned, with
  /// the supervisor's own bookkeeping pointing at a third child.
  ///
  /// The window is opened without any real timing: the health probe parks
  /// `start()` with the gate held, which is what makes the relaunch queue
  /// behind the `restart()` instead of racing it.
  @Test func aBackoffThatExpiresDuringARestartDoesNotSpawnASecondChild() async throws {
    let (launch, cleanup) = try fakeScript(
      """
      if [ -f ran ]; then
        echo 'live child'
        sleep 30
      else
        : > ran
        exit 1
      fi
      """)
    defer { cleanup() }
    let gate = ProbeGate()
    let clock = GatedTestClock(gating: 1)
    let sut = supervisor(launch, health: { await gate.wait(); return true }, clock: clock)

    let starting = Task { await sut.start() }
    // The first child has crashed and its backoff is parked in the clock, while
    // `start()` still holds the lifecycle gate on the health probe.
    try await waitUntil { await clock.slept.contains(1) }

    let restarting = Task { await sut.restart(gracePeriod: 0.3) }
    try await Task.sleep(for: .milliseconds(80))  // it queues on the lifecycle gate
    await clock.release()
    try await Task.sleep(for: .milliseconds(80))  // and the relaunch queues behind it
    await gate.open()
    await starting.value
    await restarting.value
    // The relaunch runs in the supervision task, which nothing here awaits:
    // give a stray spawn room to land rather than asserting past it.
    try await Task.sleep(for: .milliseconds(300))

    #expect(processCommandCount(containing: launch.arguments[0]) == 1)
    let live = try #require(await sut.state.pid)
    #expect(processIsAlive(live))
    await sut.stop(gracePeriod: 0.3)
    #expect(processCommandCount(containing: launch.arguments[0]) == 0)
  }

  /// HI. `terminateNow()` is the quit path and runs off the actor, so it lands
  /// wherever it lands — including in the middle of a `restart()` that has
  /// already stopped its child and is one step away from spawning the next.
  /// Its own teardown is a no-op there (the pid it would kill is the one the
  /// restart is replacing, or already gone), so the quit has to reach that
  /// turn some other way; otherwise the restart spawns a server that outlives
  /// the app.
  @Test func aQuitInsideARestartsWindowLeavesNoChildRunning() async throws {
    let (launch, cleanup) = try fakeScript("sleep 60\n")
    defer { cleanup() }
    let healthy = Mutex(false)
    let clock = GatedTestClock(gating: 0.5)
    let sut = supervisor(launch, health: { healthy.withLock { $0 } }, clock: clock)

    let starting = Task { await sut.start() }
    try await waitUntil { await clock.slept.contains(0.5) }  // parked mid health poll
    let restarting = Task { await sut.restart(gracePeriod: 0.4) }
    try await Task.sleep(for: .milliseconds(80))  // queued on the lifecycle gate
    sut.terminateNow(gracePeriod: 0.5)  // applicationWillTerminate
    healthy.withLock { $0 = true }
    await clock.release()
    await starting.value
    await restarting.value

    #expect(await sut.state == .stopped)
    #expect(processCommandCount(containing: launch.arguments[0]) == 0)
  }

  /// M1. The supervisor caps the pump's buffer so a runaway child cannot grow
  /// it without bound, which means whole chunks are dropped — mid-line, at an
  /// arbitrary byte. Silently splicing the bytes on either side together reads
  /// as output the child never printed; the hole has to be visible in the log
  /// instead.
  @Test func chunksLostToTheBufferingPolicyAreMarkedInTheLog() async throws {
    let pipe = Pipe()
    let gate = ProbeGate()
    let lines = Mutex<[String]>([])
    let pumping = Task {
      await ProcessOutputPump.pump(
        pipe.fileHandleForReading, bufferingPolicy: .bufferingNewest(1)
      ) { line in
        lines.withLock { $0.append(line) }
        if line == "first" { await gate.wait() }
      }
    }
    let writer = pipe.fileHandleForWriting
    try writer.write(contentsOf: Data("first\n".utf8))
    try await waitUntil { lines.withLock { $0.contains("first") } }
    // One readability event each, every one of them while the consumer is
    // parked, so the one-chunk buffer overflows and the oldest are dropped.
    for index in 0..<20 {
      try writer.write(contentsOf: Data("chunk \(index)\n".utf8))
      try await Task.sleep(for: .milliseconds(10))
    }
    await gate.open()
    try writer.close()
    await pumping.value

    let captured = lines.withLock { $0 }
    let marker = try #require(captured.first { $0.hasPrefix("[log dropped ") })
    #expect(marker.hasSuffix(" chunks]"))
    let firstIndex = try #require(captured.firstIndex(of: "first"))
    let markerIndex = try #require(captured.firstIndex(of: marker))
    #expect(firstIndex < markerIndex)
    // Nothing straddles the hole: every other line is one the writer wrote.
    #expect(captured.allSatisfy { $0 == "first" || $0 == marker || $0.hasPrefix("chunk ") })
  }

  /// M2. A child that exits without a final newline still printed that last
  /// line, and the pump's EOF flush is the only thing that delivers it.
  @Test func aFinalLineWithNoTrailingNewlineStillReachesTheLog() async throws {
    let (launch, cleanup) = try fakeScript("printf 'ready\\nno trailing newline'\n")
    defer { cleanup() }
    let child = Process()
    child.executableURL = launch.executable
    child.arguments = launch.arguments
    child.currentDirectoryURL = launch.workingDirectory
    let pipe = Pipe()
    child.standardOutput = pipe
    child.standardError = pipe
    try child.run()
    let lines = Mutex<[String]>([])
    await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in
      lines.withLock { $0.append(line) }
    }
    child.waitUntilExit()
    #expect(lines.withLock { $0 } == ["ready", "no trailing newline"])
  }
}
#endif
