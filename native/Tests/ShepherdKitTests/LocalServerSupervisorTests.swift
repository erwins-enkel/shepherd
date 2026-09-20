#if os(macOS)
import Foundation
import Synchronization
import Testing

@testable import ShepherdKit

/// A clock that never really sleeps: records what it was asked to wait for and
/// advances `now` by that much. Backoff assertions become exact and instant.
actor TestClock: SupervisorClock {
  private(set) var slept: [TimeInterval] = []
  private var current = Date(timeIntervalSince1970: 0)
  var now: Date { current }
  func sleep(for seconds: TimeInterval) async throws {
    slept.append(seconds)
    current = current.addingTimeInterval(seconds)
  }
  func advance(_ seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
}

/// Writes a /bin/sh script into a temp dir and returns a launch spec for it.
/// Nothing in this file runs bun, install.sh or a real Shepherd server.
func fakeScript(_ body: String) throws -> (launch: LocalServerLaunch, cleanup: () -> Void) {
  let dir = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("s5-proc-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let script = dir.appendingPathComponent("fake.sh")
  try ("#!/bin/sh\n" + body).write(to: script, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
  let launch = LocalServerLaunch(
    executable: URL(fileURLWithPath: "/bin/sh"), arguments: [script.path],
    workingDirectory: dir, environment: ["PATH": "/usr/bin:/bin"])
  return (launch, { try? FileManager.default.removeItem(at: dir) })
}

/// Polls every 20 ms up to `timeout` — neither flaky nor slow.
func waitUntil(timeout: TimeInterval = 5, _ condition: @Sendable () async -> Bool) async throws {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if await condition() { return }
    try await Task.sleep(for: .milliseconds(20))
  }
  Issue.record("condition not met within \(timeout)s")
}

/// `ps` is the independent witness that a pid is really gone: `kill(pid, 0)`
/// still succeeds for a zombie we failed to reap, `ps -p` still lists one.
func processIsAlive(_ pid: Int32) -> Bool {
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-o", "pid=", "-p", "\(pid)"]
  let out = Pipe()
  ps.standardOutput = out
  ps.standardError = Pipe()
  do { try ps.run() } catch { return false }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  ps.waitUntilExit()
  return !String(decoding: data, as: UTF8.self)
    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

/// Every pid `ps` still lists in `group`. `Process` gives each child a process
/// group of its own, so this sees the child *and its descendants* — the fake
/// script's `sleep` included, which a bare `kill(childPid)` leaves reparented
/// to launchd.
func processesInGroup(_ group: Int32) -> [Int32] {
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-axo", "pgid=,pid="]
  let out = Pipe()
  ps.standardOutput = out
  ps.standardError = Pipe()
  do { try ps.run() } catch { return [] }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  ps.waitUntilExit()
  return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { row in
    let columns = row.split(separator: " ", omittingEmptySubsequences: true)
    guard columns.count >= 2, Int32(columns[0]) == group else { return nil }
    return Int32(columns[1])
  }
}

@Suite(.serialized) struct LocalServerSupervisorProcessTests {
  private func supervisor(_ launch: LocalServerLaunch) -> LocalServerSupervisor {
    LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(capacity: 200), health: { true }, clock: TestClock(), launch: { launch })
  }

  @Test func startingRunsTheChildAndLogsItsOutput() async throws {
    let (launch, cleanup) = try fakeScript(
      "echo 'shepherd core on http://localhost:7330'\necho 'loaded 3 sessions'\nsleep 30\n")
    defer { cleanup() }
    let sut = supervisor(launch)
    await sut.start()
    #expect(await sut.state.isRunning)
    try await waitUntil { await sut.logLines().contains("loaded 3 sessions") }
    await sut.stop()
  }

  /// The password must reach `capturedPassword` and must NOT survive in the log.
  @Test func theGeneratedPasswordIsCapturedAndRedacted() async throws {
    let password = "Zx9_test-password-abcdefgh"
    let (launch, cleanup) = try fakeScript(
      """
      echo '  Operator password (shown ONCE): \(password)'
      echo 'shepherd core on http://localhost:7330'
      sleep 30
      """)
    defer { cleanup() }
    let sut = supervisor(launch)
    await sut.start()
    try await waitUntil { await sut.capturedPassword == password }
    let lines = await sut.logLines()
    #expect(lines.allSatisfy { !$0.contains(password) })
    #expect(lines.contains { $0.contains(LogRing.placeholder) })
    await sut.stop()
  }

  /// A line that arrives in two pipe reads must still reach the log — and the
  /// scanner — as exactly one line. The pump accumulates bytes and splits on
  /// newlines; a `read()` boundary is not a line boundary.
  @Test func aLineSplitAcrossTwoChunksIsReassembledExactlyOnce() async throws {
    let password = "Zx9_split-password-abcdefgh"
    let (launch, cleanup) = try fakeScript(
      """
      printf 'shepherd core on http://loc'
      sleep 0.2
      printf 'alhost:7330\\r\\n'
      printf '  Operator password (shown ONCE): Zx9_split-'
      sleep 0.2
      printf 'password-abcdefgh\\n'
      sleep 30
      """)
    defer { cleanup() }
    let sut = supervisor(launch)
    await sut.start()
    try await waitUntil { await sut.capturedPassword == password }
    let lines = await sut.logLines()
    #expect(lines.compactMap { BootLineScanner.readyPort(in: $0) } == [7330])
    #expect(lines.contains("shepherd core on http://localhost:7330"))
    #expect(lines.allSatisfy { !$0.contains(password) })
    await sut.stop()
  }

  @Test func stopTerminatesTheChildAndReportsStopped() async throws {
    let (launch, cleanup) = try fakeScript("sleep 60\n")
    defer { cleanup() }
    let sut = supervisor(launch)
    await sut.start()
    let pid = await sut.state.pid
    #expect(pid != nil)
    let group = getpgid(pid!)
    await sut.stop()
    #expect(await sut.state == .stopped)
    #expect(kill(pid!, 0) != 0)  // ESRCH — the pid is gone
    #expect(!processIsAlive(pid!))  // and not left behind as a zombie either
    #expect(processesInGroup(group).isEmpty)  // nor is its `sleep` grandchild
  }

  /// The quit path: synchronous, no await, reachable from
  /// applicationWillTerminate. The script ignores SIGTERM, so only the SIGKILL
  /// fallback can end it.
  @Test func terminateNowKillsAChildThatIgnoresSIGTERM() async throws {
    let (launch, cleanup) = try fakeScript("trap '' TERM\nsleep 60\n")
    defer { cleanup() }
    let sut = supervisor(launch)
    await sut.start()
    let pid = await sut.state.pid
    let group = getpgid(pid!)
    sut.terminateNow(gracePeriod: 0.3)  // nonisolated — no await
    #expect(kill(pid!, 0) != 0)
    #expect(!processIsAlive(pid!))
    #expect(processesInGroup(group).isEmpty)
    await sut.stop()
    // A kill we asked for is not a crash: nothing may be respawned on the way
    // out, or the app would leave a server behind every time it quits.
    #expect(await sut.state.pid == nil)
    #expect(processesInGroup(group).isEmpty)
  }

  @Test func aMissingBunOrExecutableFailsInsteadOfTrapping() async {
    let temp = URL(fileURLWithPath: NSTemporaryDirectory())
    let environment = LocalServerEnvironment(home: temp)
    let missing = LocalServerLaunch(
      executable: URL(fileURLWithPath: "/nonexistent/bun"), arguments: [],
      workingDirectory: temp, environment: [:])
    let launches: [@Sendable () -> LocalServerLaunch?] = [{ missing }, { nil }]
    for launch in launches {
      let sut = LocalServerSupervisor(
        environment: environment, log: LogRing(), health: { false },
        clock: TestClock(), launch: launch)
      await sut.start()
      #expect(await sut.state == .failed(.bunMissing))
    }
  }
}

/// A clock whose `sleep` parks on an async gate until the test releases it, so
/// a specific window inside `handleCrash`'s backoff can be held open
/// deterministically instead of raced against real timing.
actor GatedTestClock: SupervisorClock {
  private(set) var slept: [TimeInterval] = []
  private var current = Date(timeIntervalSince1970: 0)
  private var continuation: CheckedContinuation<Void, Never>?
  /// Only a sleep for exactly this duration parks — the crash loop's first
  /// backoff (`RestartPolicy.backoff[0]`, 1 s by default). Gating on "the
  /// first call ever" instead of a specific duration deadlocks `start()`
  /// itself: `waitForHealth()`'s own 0.5 s poll sleep can easily be the first
  /// call the supervisor makes, and `start()` awaits it directly, so the test
  /// would never reach the line that releases the gate. Distinct backoff
  /// values (1, 2, 4) also mean this never re-matches on a later restart.
  private let gatedDuration: TimeInterval
  init(gating gatedDuration: TimeInterval = 1) { self.gatedDuration = gatedDuration }
  var now: Date { current }
  func sleep(for seconds: TimeInterval) async throws {
    slept.append(seconds)
    current = current.addingTimeInterval(seconds)
    // Every other duration returns instantly, spending no real time at all:
    // a test clock that quietly sleeps for real is no longer a test clock, and
    // `waitForHealth()` now settles a spent poll budget against the OS rather
    // than against how much wall time the injected clock happened to burn.
    guard seconds == gatedDuration else { return }
    await withCheckedContinuation { self.continuation = $0 }
  }
  func release() {
    continuation?.resume()
    continuation = nil
  }
}

/// Every pid `ps` reports as still alive whose command line contains `needle`.
/// Used instead of a tracked pid where the supervisor's own `state` no longer
/// exposes one (e.g. `.failed`), to prove a child is really gone rather than
/// just relabelled.
func anyProcessCommand(contains needle: String) -> Bool {
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-axo", "command="]
  let out = Pipe()
  ps.standardOutput = out
  ps.standardError = Pipe()
  do { try ps.run() } catch { return false }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  ps.waitUntilExit()
  return String(decoding: data, as: UTF8.self).contains(needle)
}

/// Regression tests for the coordinator's review of 6ad9d257 (Task 3): the
/// pump's report was not tied to the child it came from, `terminateNow()`
/// could wedge the crash-loop's own relaunch, `stop()` blocked the actor for
/// its whole grace period, and a health timeout mislabelled a child that was
/// still alive as `.exited`.
@Suite(.serialized) struct LocalServerSupervisorFixTests {
  /// `stop()` cancels the pump, but Task cancellation does not abort an
  /// in-flight `for await` loop, so a late exit report from the child being
  /// stopped can still reach the actor after the next `start()` has already
  /// spawned a new one. Before the `spawnGeneration` guard this crashed
  /// (`terminationStatus` read on the new, still-running `Process`) or spawned
  /// a spurious extra restart; fast, repeated stop/restart cycles hit the race
  /// reliably because there is no delay between the old child's teardown and
  /// the next spawn.
  @Test func aStaleExitFromAnOldChildNeverDisruptsTheNextOne() async throws {
    let (launch, cleanup) = try fakeScript("exit 0\n")
    defer { cleanup() }
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(capacity: 200), health: { true }, clock: TestClock(), launch: { launch })
    for _ in 0..<25 {
      await sut.start()
      await sut.restart()
    }
    await sut.stop()
    #expect(await sut.state == .stopped)
  }

  /// `terminateNow()` must be a true no-op when nothing is running — including
  /// a speculative call mid crash-loop backoff, when there is momentarily no
  /// live child. Before the fix it marked `stopping` unconditionally, and
  /// unlike `start()`, `relaunch()` never clears that flag — so a single such
  /// call permanently wedged the crash loop's own recovery.
  @Test func terminateNowDuringTheCrashLoopWindowDoesNotBlockTheNextRestart() async throws {
    let (launch, cleanup) = try fakeScript("exit 1\n")
    defer { cleanup() }
    let clock = GatedTestClock(gating: 1)
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(capacity: 50), health: { false }, clock: clock, launch: { launch })
    await sut.start()
    // The child has already crashed once and `handleCrash` is now parked in
    // `clock.sleep` for the first backoff — exactly the window with no live
    // child.
    try await waitUntil { await clock.slept.contains(1) }
    #expect(await sut.state.pid == nil)
    sut.terminateNow()  // as `applicationWillTerminate` might call it speculatively
    await clock.release()
    try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 3)) }
  }

  /// `stop()` must not block the actor for its whole grace period: a `state`
  /// read issued while `stop()` is waiting out a SIGTERM-ignoring child has to
  /// return promptly, not queue up behind the wait.
  @Test func stopDoesNotBlockTheActorWhileWaitingOutTheGracePeriod() async throws {
    let (launch, cleanup) = try fakeScript("trap '' TERM\nsleep 60\n")
    defer { cleanup() }
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(), health: { true }, clock: TestClock(), launch: { launch })
    await sut.start()
    let stopTask = Task { await sut.stop(gracePeriod: 2) }
    try await Task.sleep(for: .milliseconds(150))  // let stop() start its wait
    let started = Date()
    _ = await sut.state
    #expect(Date().timeIntervalSince(started) < 0.5)
    await stopTask.value
    #expect(await sut.state == .stopped)
  }

  /// A child that never answers `/api/health` is not necessarily dead. The
  /// timeout must report a dedicated failure and actually tear the child down
  /// — not relabel a still-running process as `.exited`, which would leave it
  /// running, unsupervised, behind a state that says otherwise.
  @Test func aHealthTimeoutTearsDownTheChildInsteadOfClaimingItExited() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(), health: { false }, clock: TestClock(), launch: { launch })
    await sut.start()
    #expect(await sut.state == .failed(.healthTimeout))
    try await waitUntil { !anyProcessCommand(contains: launch.arguments[0]) }
  }
}

@Suite(.serialized) struct LocalServerRestartTests {
  /// A child that exits immediately is restarted after 1 s, 2 s, 4 s; the fourth
  /// crash inside the window stops the supervisor.
  @Test func threeRestartsThenCrashLoop() async throws {
    let (launch, cleanup) = try fakeScript("exit 1\n")
    defer { cleanup() }
    let clock = TestClock()
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(capacity: 50), health: { false }, clock: clock, launch: { launch })
    await sut.start()
    try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 3)) }
    #expect(await clock.slept.filter { [1, 2, 4].contains($0) } == [1, 2, 4])
  }

  /// An operator's own `restart()` forgives the crashes before it, so a server
  /// that dies once in a while stays supervised instead of accumulating into a
  /// crash loop. Asserting only the end state is not enough — it is reached
  /// either way. What separates a cleared history from a kept one is that the
  /// supervisor tries again at all: a *new* backoff wait after `restart()`.
  @Test func restartClearsTheCrashHistory() async throws {
    let (launch, cleanup) = try fakeScript("exit 1\n")
    defer { cleanup() }
    var policy = LocalServerSupervisor.RestartPolicy()
    policy.maxRestarts = 1
    let clock = TestClock()
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(capacity: 50), health: { false }, clock: clock, policy: policy,
      launch: { launch })
    await sut.start()
    try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 1)) }
    let backoffsBefore = await clock.slept.filter { $0 == policy.backoff[0] }.count
    #expect(backoffsBefore == 1)
    await clock.advance(10)  // still well inside the 300 s window
    await sut.restart()
    try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 1)) }
    let backoffsAfter = await clock.slept.filter { $0 == policy.backoff[0] }.count
    #expect(backoffsAfter == backoffsBefore + 1)
  }

  /// Health, not the ready line, is what flips `.starting` to `.running`.
  @Test func healthDecidesReadiness() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let healthy = Mutex(true)
    let sut = LocalServerSupervisor(
      environment: LocalServerEnvironment(home: launch.workingDirectory),
      log: LogRing(), health: { healthy.withLock { $0 } }, clock: TestClock(),
      launch: { launch })
    await sut.start()
    #expect(await sut.state.isRunning)
    await sut.stop()
  }
}


/// How many live processes `ps` still reports whose command line contains
/// `needle` — the count `anyProcessCommand(contains:)` cannot give, and the
/// only way to tell "one child, replaced" from "two children, one orphaned".
/// `-ww` because the fake scripts live under long temp paths that `ps` would
/// otherwise truncate.
func processCommandCount(containing needle: String) -> Int {
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-axww", "-o", "command="]
  let out = Pipe()
  ps.standardOutput = out
  ps.standardError = Pipe()
  do { try ps.run() } catch { return 0 }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  ps.waitUntilExit()
  return String(decoding: data, as: UTF8.self).split(separator: "\n")
    .filter { $0.contains(needle) }.count
}

/// Regression tests for the coordinator's second review pass: the exit report
/// of a child the supervisor had already moved past still acted on the *next*
/// child, two overlapping `restart()`s tore each other's children down, a
/// spent health budget was decided against wall time rather than against the
/// OS, `.running(pid:)` was claimed before anything had answered `/api/health`,
/// and one shared `lastExitCode` slot was read across generations.
@Suite(.serialized) struct LocalServerSupervisorFix2Tests {
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

  /// BL-1. `childStreamEnded` checked the generation once, then suspended in
  /// `exitCode()` for up to 500 ms waiting on the termination handler. A
  /// `restart()` landing in that window spawned the next child; the stale
  /// report then resumed and cleared *its* pid and process and drove a crash
  /// restart, orphaning a live, unowned server.
  ///
  /// The seam is EOF without exit: the first child closes its pipe and keeps
  /// running, which splits the two notifications `childStreamEnded` sits
  /// between and parks it in `exitCode()` for the whole window. Later children
  /// keep their pipe open, so only the first one produces a stale report.
  @Test func aStaleExitReportAfterARestartLeavesTheNewChildAlone() async throws {
    let (launch, cleanup) = try fakeScript(
      """
      if [ -f ran ]; then
        echo 'later child is up'
        sleep 30
      else
        : > ran
        echo 'first child is up'
        exec 1>&-
        exec 2>&-
        sleep 30
      fi
      """)
    defer { cleanup() }
    let sut = supervisor(launch, health: { true })
    await sut.start()
    let first = try #require(await sut.state.pid)
    try await waitUntil { await sut.logLines().contains("first child is up") }
    try await Task.sleep(for: .milliseconds(100))  // let the EOF reach the pump
    await sut.restart(gracePeriod: 0.2)
    let second = try #require(await sut.state.pid)
    #expect(second != first)
    // Past `exitCode()`'s 500 ms cap: the stale report resumes inside here.
    try await Task.sleep(for: .milliseconds(700))
    #expect(await sut.state.pid == second)
    #expect(processIsAlive(second))
    #expect(processCommandCount(containing: launch.arguments[0]) == 1)
    await sut.stop(gracePeriod: 0.3)
    #expect(processCommandCount(containing: launch.arguments[0]) == 0)
  }

  /// BL-2. `stop()` suspends while it waits the child out, so a second
  /// `restart()` got its turn in the middle of the first one: it resumed still
  /// holding the *first* child's pid, cleared the pid of the replacement the
  /// first `restart()` had meanwhile spawned, cancelled its pump and declared
  /// the supervisor `.stopped` — leaving that replacement alive and unowned,
  /// while its own `start()` spawned a third child.
  ///
  /// The 5 ms stagger is the whole point: both waits poll on the same 20 ms
  /// period, so the second one always resumes just *after* the first, which by
  /// then has already synchronously spawned the replacement. Repeated because
  /// one round leaves the supervisor's own bookkeeping intact — only the
  /// process table shows the damage.
  @Test func twoOverlappingRestartsLeaveExactlyOneLiveChild() async throws {
    let (launch, cleanup) = try fakeScript("sleep 60\n")
    defer { cleanup() }
    let sut = supervisor(launch, health: { true })
    await sut.start()
    for _ in 0..<3 {
      let first = Task { await sut.restart(gracePeriod: 0.3) }
      try await Task.sleep(for: .milliseconds(5))
      let second = Task { await sut.restart(gracePeriod: 0.3) }
      await first.value
      await second.value
      let pid = try #require(await sut.state.pid)
      #expect(processIsAlive(pid))
      #expect(processCommandCount(containing: launch.arguments[0]) == 1)
    }
    await sut.stop(gracePeriod: 0.3)
    #expect(processCommandCount(containing: launch.arguments[0]) == 0)
  }

  /// HI-1. A child that is already dead when the health budget runs out is a
  /// crash, not a health timeout — `.healthTimeout` is only for a child that is
  /// still there and refusing to answer. With an injected clock that spends no
  /// real time, the whole 60-poll budget can run before the dead child's pipe
  /// EOF has even been delivered, so the budget's end must be settled against
  /// the OS rather than against how much wall time happened to pass.
  @Test func anAlreadyDeadChildIsNotMislabelledAsAHealthTimeout() async throws {
    let (launch, cleanup) = try fakeScript("exit 1\n")
    defer { cleanup() }
    var policy = LocalServerSupervisor.RestartPolicy()
    policy.maxRestarts = 0  // the first crash is the last one
    let sut = supervisor(launch, health: { false }, policy: policy)
    await sut.start()
    try await waitUntil(timeout: 10) { await sut.state == .failed(.crashLoop(restarts: 0)) }
  }

  /// HI-2. `.running(pid:)` is a promise that the server answers requests, so
  /// spawning alone must not claim it: the state stays `.starting` until
  /// `/api/health` says yes. The gated clock parks on `waitForHealth()`'s own
  /// poll interval, which holds the mid-poll moment open with no real sleep.
  @Test func aSpawnedChildIsNotCalledRunningUntilHealthPasses() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let healthy = Mutex(false)
    let clock = GatedTestClock(gating: 0.5)
    let sut = supervisor(launch, health: { healthy.withLock { $0 } }, clock: clock)
    let starting = Task { await sut.start() }
    try await waitUntil { await clock.slept.contains(0.5) }  // the first poll said no
    #expect(await sut.state == .starting)
    healthy.withLock { $0 = true }
    await clock.release()
    await starting.value
    #expect(await sut.state.isRunning)
    await sut.stop(gracePeriod: 0.3)
  }

  /// ME-1. One `lastExitCode` slot is read by every generation, so the dead
  /// first child's code must not make the live, hung second child look dead —
  /// which would leave it running behind a state that never reports it.
  @Test func aPreviousChildsExitCodeNeverStandsInForTheCurrentOne() async throws {
    let (launch, cleanup) = try fakeScript(
      """
      if [ -f ran ]; then
        sleep 30
      else
        : > ran
        exit 7
      fi
      """)
    defer { cleanup() }
    let sut = supervisor(launch, health: { false })
    await sut.start()
    try await waitUntil(timeout: 15) { await sut.state == .failed(.healthTimeout) }
    try await waitUntil { processCommandCount(containing: launch.arguments[0]) == 0 }
  }
}

#endif
