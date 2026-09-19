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
#endif
