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
    guard seconds == gatedDuration else {
      // A real, brief sleep rather than an instant return: `waitForHealth()`'s
      // poll loop calls this every iteration, and an instant return lets it
      // race through all 60 iterations faster than the child's pipe EOF can
      // ever be delivered and processed, reaching the iteration cap before
      // the crash this test needs is even detected.
      try? await Task.sleep(for: .milliseconds(2))
      return
    }
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

#endif
