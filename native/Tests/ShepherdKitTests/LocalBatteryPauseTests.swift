#if os(macOS)
import Darwin
import Foundation
import SQLite3
import Synchronization
import Testing
@testable import ShepherdKit

@Suite(.timeLimit(.minutes(1))) struct LocalBatteryPauseTests {
  @Test func processArgumentsAreNotMistakenForEnvironmentMarkers() {
    func bytes(_ args: [String], _ env: [String]) -> [UInt8] {
      var count = Int32(args.count)
      return withUnsafeBytes(of: &count) { Array($0) }
        + Array("/bin/sh\0\0".utf8)
        + args.flatMap { Array($0.utf8) + [0] }
        + env.flatMap { Array($0.utf8) + [0] }
    }
    let data = bytes(["sh", "-c", "SHEPHERD_SESSION_ID=wrong", ""],
                     ["PRIVATE=never-return", "SHEPHERD_SESSION_ID=right"])
    let parsed = BatteryProcess.provenance(in: data)
    #expect(parsed?.sessionID == "right")
    #expect(parsed?.matches(ids: ["wrong"]) == false)
    let reviewer = BatteryProcess.provenance(in: bytes(["claude", "--session-id", "reviewer"], ["PATH=/bin"]))
    #expect(reviewer?.matches(ids: ["reviewer"]) == true)
    #expect(BatteryProcess.provenance(in: [0, 1]) == nil)
  }

  @Test func readsOnlyThisDatabasesSessionsAndReviewers() throws {
    let fixture = try Fixture()
    defer { fixture.cleanup() }
    #expect(try BatterySessionIDs.read(fixture.database.path) == [fixture.sessionID, "reviewer", "provider-session"])
    #expect(throws: (any Error).self) { try BatterySessionIDs.read(fixture.directory.appendingPathComponent("missing.db").path) }
    #expect(!FileManager.default.fileExists(atPath: fixture.directory.appendingPathComponent("missing.db").path))
  }

  @Test func runnerLookupIncludesRecordedAuxiliariesAndExcludesForeignPanes() async throws {
    let fixture = try Fixture()
    defer { fixture.cleanup() }
    let main = try fixture.worker("main")
    let auxiliary = try fixture.worker("auxiliary")
    let foreign = try fixture.worker("foreign")
    defer { for child in [main, auxiliary, foreign] { fixture.stop(child) } }
    try fixture.writeOwnership(main)
    let runner = fixture.directory.appendingPathComponent("fake-herdr")
    let body = """
      #!/bin/sh
      if [ "$1" = agent ]; then
        echo '{"result":{"agents":[{"terminal_id":"terminal-main","pane_id":"main"},{"terminal_id":"foreign-terminal","pane_id":"foreign"}]}}'
      elif [ "$2" = list ]; then
        echo '{"result":{"panes":[{"pane_id":"main"},{"pane_id":"auxiliary"},{"pane_id":"foreign"}]}}'
      else
        case "$4" in
          main) pid=\(main.processIdentifier) ;;
          auxiliary) pid=\(auxiliary.processIdentifier) ;;
          foreign) pid=\(foreign.processIdentifier) ;;
          *) exit 1 ;;
        esac
        echo "{\\"result\\":{\\"process_info\\":{\\"shell_pid\\":$pid}}}"
      fi
      """
    try body.write(to: runner, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runner.path)
    try "\"auxiliary\"\n\"closed-pane\"\n".write(toFile: fixture.database.path + ".power-panes", atomically: true, encoding: .utf8)
    let owner = try LocalBatteryPause.owner(at: fixture.pause.ownershipURL)
    let targets = try await BatteryPaneTargets.resolve(owner: owner, runner: runner, socket: "/test/socket")
    #expect(Set(targets.map(\.pid)) == [main.processIdentifier, auxiliary.processIdentifier])
    #expect(BatteryProcess(foreign.processIdentifier)?.info?.pbi_status != UInt32(SSTOP))
  }

  @Test func pausesRealWorkAndResumesOnlyOwnedProcessesOnExternalPower() async throws {
    let fixture = try Fixture()
    defer { fixture.cleanup() }
    let server = try fixture.worker("server")
    let agent = try fixture.worker("agent", env: ["SHEPHERD_SESSION_ID": fixture.sessionID])
    let auxiliary = try fixture.worker("auxiliary")
    let unrelated = try fixture.worker("unrelated", env: ["SHEPHERD_SESSION_ID": UUID().uuidString])
    let previouslyStopped = try fixture.worker("already-stopped", env: ["SHEPHERD_SESSION_ID": fixture.sessionID])
    let children = [server, agent, auxiliary, unrelated, previouslyStopped]
    defer { for child in children { fixture.stop(child) } }
    let stopped = try #require(BatteryProcess(previouslyStopped.processIdentifier))
    try stopped.signal(SIGSTOP)
    try await waitUntil { stopped.info?.pbi_status == UInt32(SSTOP) }
    try fixture.writeOwnership(server)
    let power = Mutex(MacPowerSource.battery)
    let roots = try [agent, auxiliary, previouslyStopped].map { try #require(BatteryProcess($0.processIdentifier)) }
    let task = Task {
      try await LocalBatteryPause.runHelper(ownershipURL: fixture.pause.ownershipURL,
          journalURL: fixture.pause.journalURL, power: { power.withLock { $0 } }, paneRoots: { _ in roots })
    }
    defer { task.cancel() }
    try await waitUntil(timeout: 15) { fixture.pause.phase == .paused }
    #expect(BatteryProcess(server.processIdentifier)?.info?.pbi_status == UInt32(SSTOP))
    #expect(BatteryProcess(agent.processIdentifier)?.info?.pbi_status == UInt32(SSTOP))
    #expect(BatteryProcess(auxiliary.processIdentifier)?.info?.pbi_status == UInt32(SSTOP))
    #expect(BatteryProcess(unrelated.processIdentifier)?.info?.pbi_status != UInt32(SSTOP))
    let before = fixture.ticks("server") + fixture.ticks("agent") + fixture.ticks("auxiliary")
    let unrelatedBefore = fixture.ticks("unrelated")
    try await Task.sleep(for: .milliseconds(300))
    #expect(fixture.ticks("server") + fixture.ticks("agent") + fixture.ticks("auxiliary") == before)
    #expect(fixture.ticks("unrelated") > unrelatedBefore)
    // Unknown power must not undo a deliberate pause.
    power.withLock { $0 = .unknown }
    try await Task.sleep(for: .milliseconds(2100))
    #expect(fixture.pause.phase == .paused)
    power.withLock { $0 = .external }
    try await task.value
    #expect(fixture.pause.phase == .running)
    #expect(stopped.info?.pbi_status == UInt32(SSTOP))
    try await waitUntil { fixture.ticks("server") + fixture.ticks("agent") + fixture.ticks("auxiliary") > before }
  }

  @Test func manualResumeAndCancellationReleaseOwnedWork() async throws {
    for cancel in [false, true] {
      let fixture = try Fixture()
      defer { fixture.cleanup() }
      let server = try fixture.worker("server")
      defer { fixture.stop(server) }
      try fixture.writeOwnership(server)
      let task = Task {
        do {
          try await LocalBatteryPause.runHelper(ownershipURL: fixture.pause.ownershipURL,
            journalURL: fixture.pause.journalURL, power: { .battery })
        } catch {
          if !Task.isCancelled { Issue.record("Pause failed before manual resume: \(error)") }
          throw error
        }
      }
      defer { task.cancel() }
      try await waitUntil(timeout: 15) { fixture.pause.phase == .paused }
      if cancel { task.cancel() } else { try fixture.pause.resume() }
      _ = await task.result
      #expect(!fixture.pause.phase.isActive)
      #expect(BatteryProcess(server.processIdentifier)?.info?.pbi_status != UInt32(SSTOP))
    }
  }

  @Test func returnedPowerAndInvalidOwnershipNeverStopServer() async throws {
    let fixture = try Fixture()
    defer { fixture.cleanup() }
    let server = try fixture.worker("server")
    defer { fixture.stop(server) }
    try fixture.writeOwnership(server)
    try await LocalBatteryPause.runHelper(ownershipURL: fixture.pause.ownershipURL,
      journalURL: fixture.pause.journalURL, power: { .external })
    #expect(fixture.pause.phase == .running)
    #expect(BatteryProcess(server.processIdentifier)?.info?.pbi_status != UInt32(SSTOP))
    var record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: fixture.pause.ownershipURL))
    record.identity = nil
    try JSONEncoder().encode(record).write(to: fixture.pause.ownershipURL)
    await #expect(throws: (any Error).self) {
      try await LocalBatteryPause.runHelper(ownershipURL: fixture.pause.ownershipURL,
        journalURL: fixture.pause.journalURL, power: { .battery })
    }
    #expect(BatteryProcess(server.processIdentifier)?.info?.pbi_status != UInt32(SSTOP))
  }

  @Test func abandonedGuardianRecoveryRestoresOnlyRecordedBirthIdentities() async throws {
    let fixture = try Fixture()
    defer { fixture.cleanup() }
    let server = try fixture.worker("server")
    let guardian = try fixture.worker("guardian")
    defer { fixture.stop(server); fixture.stop(guardian) }
    let process = try #require(BatteryProcess(server.processIdentifier))
    let deadGuardian = try #require(BatteryProcess(guardian.processIdentifier))
    fixture.stop(guardian)
    var journal = BatteryPauseJournal(phase: .pausing, helper: deadGuardian, server: process, processes: [])
    try await LocalBatteryPause.suspend(process, journal: &journal, url: fixture.pause.journalURL)
    #expect(process.info?.pbi_status == UInt32(SSTOP))
    try fixture.pause.recoverAbandonedPause()
    #expect(fixture.pause.phase == .running)
    try await waitUntil { process.info?.pbi_status != UInt32(SSTOP) }
  }

  @Test func quittingTheServerParentKeepsWorkPausedUntilPowerReturns() async throws {
    let fixture = try Fixture()
    defer { fixture.cleanup() }
    try "trap '' HUP\nwhile :; do echo tick >> server; sleep 0.03; done\n".write(
      to: fixture.directory.appendingPathComponent("fake.sh"), atomically: true, encoding: .utf8)
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let binary = try #require([".build/out/Products/Debug", ".build/debug"].map {
      package.appendingPathComponent($0 + "/LocalServerLifecycleHelper")
    }.first { FileManager.default.isExecutableFile(atPath: $0.path) })
    let parent = Process()
    parent.executableURL = binary
    parent.arguments = [fixture.directory.path, "battery-parent"]
    parent.standardOutput = FileHandle.nullDevice
    parent.standardError = FileHandle.nullDevice
    try parent.run()
    defer { fixture.stop(parent) }
    try await waitUntil { fixture.ticks("server") > 0 }
    let pid = try #require(Int32(String(contentsOf: fixture.directory.appendingPathComponent("server.pid"), encoding: .utf8)))
    let server = try #require(BatteryProcess(pid))
    defer { if server.alive { killpg(pid, SIGCONT); killpg(pid, SIGKILL) } }
    try fixture.writeOwnership(pid)
    let power = Mutex(MacPowerSource.battery)
    let guardian = Task {
      try await LocalBatteryPause.runHelper(ownershipURL: fixture.pause.ownershipURL,
        journalURL: fixture.pause.journalURL, power: { power.withLock { $0 } })
    }
    defer { guardian.cancel() }
    try await waitUntil(timeout: 15) { fixture.pause.phase == .paused }
    try Data().write(to: fixture.directory.appendingPathComponent("quit-parent"))
    try await waitUntil { !parent.isRunning }
    let before = fixture.ticks("server")
    try await Task.sleep(for: .milliseconds(400))
    #expect(server.info?.pbi_status == UInt32(SSTOP))
    #expect(fixture.ticks("server") == before)
    power.withLock { $0 = .external }
    try await guardian.value
    try await waitUntil { fixture.ticks("server") > before }
  }

  private struct Fixture: Sendable {
    let directory: URL
    let database: URL
    let pause: LocalBatteryPause
    let sessionID = UUID().uuidString

    init() throws {
      directory = FileManager.default.temporaryDirectory.appendingPathComponent("battery-test-\(UUID())")
      database = directory.appendingPathComponent(".shepherd/shepherd.db")
      try FileManager.default.createDirectory(at: directory.appendingPathComponent(".shepherd/run"), withIntermediateDirectories: true)
      pause = LocalBatteryPause(environment: LocalServerEnvironment(home: directory, processEnvironment: [:]))
      var db: OpaquePointer?
      guard sqlite3_open(database.path, &db) == SQLITE_OK else { throw BatteryPauseError.database }
      defer { sqlite3_close(db) }
    let sql = "CREATE TABLE sessions (id TEXT, herdrAgentId TEXT, terminalPaneId TEXT); INSERT INTO sessions VALUES ('\(sessionID)', 'terminal-main', NULL); CREATE TABLE reviewer_spawns (reviewerSessionId TEXT, providerSessionId TEXT); INSERT INTO reviewer_spawns VALUES ('reviewer', 'provider-session');"
      guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw BatteryPauseError.database }
    }

    func worker(_ name: String, env: [String: String] = [:]) throws -> Process {
      let child = Process()
      child.executableURL = URL(fileURLWithPath: "/bin/sh")
      child.arguments = ["-c", "while :; do echo tick >> \"$1\"; sleep 0.03; done", "battery-test", directory.appendingPathComponent(name).path]
      child.environment = env.merging(["PATH": "/usr/bin:/bin"]) { value, _ in value }
      child.standardOutput = FileHandle.nullDevice
      child.standardError = FileHandle.nullDevice
      child.terminationHandler = { _ in }
      try child.run()
      // Production ownership is granted only after health succeeds, never during shell startup.
      let deadline = Date().addingTimeInterval(2)
      while ticks(name) == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
      return child
    }

    func ticks(_ name: String) -> Int { (try? Data(contentsOf: directory.appendingPathComponent(name)).count) ?? 0 }
    func stop(_ child: Process) {
      guard child.isRunning else { return }
      killpg(child.processIdentifier, SIGCONT)
      killpg(child.processIdentifier, SIGKILL)
      // After an await, Foundation's run-loop wait can miss an already-reaped
      // child's exit. Observe the OS directly and bound fixture cleanup.
      let deadline = Date().addingTimeInterval(2)
      while Date() < deadline {
        let result = waitpid(child.processIdentifier, nil, WNOHANG)
        if result == child.processIdentifier || (result == -1 && errno == ECHILD) { return }
        Thread.sleep(forTimeInterval: 0.01)
      }
      Issue.record("Battery fixture child did not exit: \(child.processIdentifier)")
    }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
    func writeOwnership(_ child: Process) throws {
      try writeOwnership(child.processIdentifier)
    }
    func writeOwnership(_ pid: Int32) throws {
      let identity = LocalServerIdentity(appDirectory: directory.path, databasePath: database.path, instanceID: "test")
      let owner = LocalServerOwnership(pid: pid, processGroup: pid,
        port: 7330, spawnedAt: Date(), processStart: KernelProcessIdentity.read(pid),
        executable: "/bin/sh", appDirectory: directory.path, expectedIdentity: identity, identity: identity)
      try JSONEncoder().encode(owner).write(to: pause.ownershipURL)
    }
  }
}
#endif
