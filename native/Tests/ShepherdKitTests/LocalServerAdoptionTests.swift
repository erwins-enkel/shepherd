#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized, .timeLimit(.minutes(1))) struct LocalServerAdoptionTests {
  private func supervisor(_ launch: LocalServerLaunch, clock: any SupervisorClock = TestClock()) -> LocalServerSupervisor {
    LocalServerSupervisor(environment: LocalServerEnvironment(home: launch.workingDirectory),
      health: { true }, clock: clock,
      runDirectory: launch.workingDirectory.appendingPathComponent("run"), launch: { launch })
  }

  private func recordURL(_ launch: LocalServerLaunch) -> URL {
    launch.workingDirectory.appendingPathComponent("run/" + LocalServerOwnership.configurationName(LocalServerEnvironment(home: launch.workingDirectory)) + ".json")
  }

  @Test func quitLeavesTheChildAndOwnershipRecordAlive() async throws {
    let (launch, cleanup) = try fakeScript("while :; do echo alive; sleep 0.1; done\n")
    defer { cleanup() }
    let sut = supervisor(launch)
    defer { sut.terminateNow(gracePeriod: 0) }
    await sut.start()
    let pid = try #require(await sut.state.pid)
    sut.terminateForQuit()
    try await Task.sleep(for: .milliseconds(250))
    #expect(processIsAlive(pid))
    #expect(FileManager.default.fileExists(atPath: recordURL(launch).path))
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    #expect(record.pid == pid)
    #expect(record.processGroup == pid)
    #expect(record.identity != nil)
    await sut.stop(gracePeriod: 0.3)
  }

  @Test func adoptionResumesLogsWithoutOfferingAPasswordAndStopRemovesTheRecord() async throws {
    let (launch, cleanup) = try fakeScript("echo 'Operator password (shown ONCE): adoption_test_secret'\nwhile :; do echo continued; sleep 0.1; done\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    #expect(await next.state == .running(pid: pid))
    try await waitUntil { await next.logLines().contains("continued") }
    #expect(await next.capturedPassword == nil)
    #expect(await next.logLines().allSatisfy { !$0.contains("adoption_test_secret") })
    let logURL = recordURL(launch).deletingPathExtension().appendingPathExtension("log")
    let contents = try String(contentsOf: logURL, encoding: .utf8)
    #expect(!contents.contains("adoption_test_secret"))
    let attributes = try FileManager.default.attributesOfItem(atPath: logURL.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    await next.stop(gracePeriod: 0.3)
    #expect(!processIsAlive(pid))
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
  }

  @Test func quittingDuringStartupStillAllowsHealthyAdoptionOnTheNextLaunch() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let gate = ProbeGate()
    let first = LocalServerSupervisor(environment: LocalServerEnvironment(home: launch.workingDirectory),
      health: { await gate.wait(); return true }, runDirectory: launch.workingDirectory.appendingPathComponent("run"),
      launch: { launch })
    defer { first.terminateNow(gracePeriod: 0) }
    let starting = Task { await first.start() }
    try await waitUntil { await gate.waitCount > 0 }
    first.terminateForQuit()
    await gate.open()
    await starting.value
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    #expect(record.identity == nil)
    #expect(processIsAlive(record.pid))
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.expectedIdentity))
    #expect(await next.state == .running(pid: record.pid))
    await next.stop(gracePeriod: 0.3)
  }

  @Test func aDeadPidRecordIsRemoved() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let sut = supervisor(launch)
    defer { sut.terminateNow(gracePeriod: 0) }
    await sut.start()
    let bytes = try Data(contentsOf: recordURL(launch))
    await sut.stop(gracePeriod: 0.3)
    try bytes.write(to: recordURL(launch))
    let next = supervisor(launch)
    #expect(await !next.adopt(healthyIdentity: nil))
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
  }

  @Test func anIdentityMismatchLeavesTheForeignServerUntouched() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let next = supervisor(launch)
    let foreign = LocalServerIdentity(appDirectory: "/foreign", databasePath: "/foreign/db", instanceID: "foreign")
    #expect(await !next.adopt(healthyIdentity: foreign))
    #expect(await next.state == .stopped)
    #expect(processIsAlive(pid))
    #expect(FileManager.default.fileExists(atPath: recordURL(launch).path))
    await first.stop(gracePeriod: 0.3)
  }

  @Test func anAdoptedServerDeathRestartsThroughTheExistingPolicy() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let clock = TestClock()
    let next = supervisor(launch, clock: clock)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    killpg(pid, SIGKILL)
    try await waitUntil { let state = await next.state; return state.isRunning && state.pid != pid }
    let replacement = try #require(await next.state.pid)
    #expect(processIsAlive(replacement))
    #expect(await clock.slept == [1])
    await next.stop(gracePeriod: 0.3)
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
  }

  @Test func deploymentRecoveryTeardownRequiresKernelOwnershipEvenWithoutHealth() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    await next.setIdentityProbeForTesting { _ in KernelProcessIdentity(seconds: 0, microseconds: 0) }
    let bytes = try Data(contentsOf: recordURL(launch))
    #expect(await !next.stopForDeploymentRecovery(healthyIdentity: nil))
    #expect(processIsAlive(pid))
    // Put back this fixture's record; stale-record removal is intentional.
    try bytes.write(to: recordURL(launch))
    await next.setIdentityProbeForTesting { KernelProcessIdentity.read($0) }
    #expect(await next.stopForDeploymentRecovery(healthyIdentity: nil))
    #expect(!processIsAlive(pid))
    #expect(await next.state == .stopped)
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
  }

  @Test func adoptedMonitorCannotRelaunchWhileUpdateRecoveryIsSuspended() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let clock = TestClock()
    let next = supervisor(launch, clock: clock)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    #expect(await next.suspendRecovery())
    killpg(pid, SIGKILL)
    try await waitUntil { if case .failed(.exited) = await next.state { return true }; return false }
    try await Task.sleep(for: .milliseconds(250))
    #expect(await next.state == .failed(.exited(code: -1)))
    #expect(await clock.slept.isEmpty)
    let unchanged = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    #expect(unchanged.pid == pid)
    await next.resumeRecovery(restartIfNeeded: true)
    #expect(await next.state.isRunning)
    #expect(await next.state.pid != pid)
    await next.stop(gracePeriod: 0.3)
  }

  @Test func kernelStartMismatchCannotAdoptOrSignalALivePid() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let bytes = try Data(contentsOf: recordURL(launch))
    var json = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    json["processStart"] = ["seconds": 0, "microseconds": 0]
    try JSONSerialization.data(withJSONObject: json).write(to: recordURL(launch))
    let next = supervisor(launch)
    #expect(await !next.adopt(healthyIdentity: try firstIdentity(bytes)))
    await next.stop(gracePeriod: 0)
    #expect(processIsAlive(pid))
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
    await first.stop(gracePeriod: 0.3)
  }

  private func firstIdentity(_ bytes: Data) throws -> LocalServerIdentity? {
    try JSONDecoder().decode(LocalServerOwnership.self, from: bytes).identity
  }

  @Test func everyStopPathRevalidatesTheAdoptedProcessBeforeSignalling() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let next = supervisor(launch)
    #expect(await next.adopt(healthyIdentity: record.identity))
    // Simulate reuse between adoption and Stop, without relying on the kernel
    // to recycle a particular pid during a test.
    await next.setIdentityProbeForTesting { target in
      target == pid ? KernelProcessIdentity(seconds: 0, microseconds: 0) : KernelProcessIdentity.read(target)
    }
    next.terminateNow(gracePeriod: 0)
    await next.stop(gracePeriod: 0)
    #expect(processIsAlive(pid))
    await first.stop(gracePeriod: 0.3)
  }

  @Test func monitorTreatsAReusedPidAsAnExitAndNeverKillsItsReplacement() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    await next.setIdentityProbeForTesting { target in
      target == pid ? KernelProcessIdentity(seconds: 0, microseconds: 0) : KernelProcessIdentity.read(target)
    }
    try await waitUntil { let state = await next.state; return state.isRunning && state.pid != pid }
    #expect(processIsAlive(pid))
    await next.stop(gracePeriod: 0.3)
    await first.stop(gracePeriod: 0.3)
  }

  @Test func otherConfigurationsAndDatabaseChangesPreserveLiveOwnership() async throws {
    let (launch, cleanup) = try fakeScript("sleep 30\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    let pid = try #require(await first.state.pid)
    first.terminateForQuit()
    let url = recordURL(launch)
    let bytes = try Data(contentsOf: url)
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: bytes)
    for values in [["SHEPHERD_PORT": "17777"], ["SHEPHERD_DIR": "/another/install"], ["SHEPHERD_DB": "/another/database"]] {
      let environment = LocalServerEnvironment(home: launch.workingDirectory, processEnvironment: values)
      let next = LocalServerSupervisor(environment: environment, health: { true },
        runDirectory: launch.workingDirectory.appendingPathComponent("run"), launch: { launch })
      #expect(next.recordURL != url)
      // Even a misplaced copy at this namespace cannot authorize adoption or
      // be deleted just because its configuration differs.
      try bytes.write(to: next.recordURL)
      #expect(await !next.adopt(healthyIdentity: record.identity))
      #expect(try Data(contentsOf: next.recordURL) == bytes)
      #expect(try Data(contentsOf: url) == bytes)
      #expect(processIsAlive(pid))
    }
    await first.stop(gracePeriod: 0.3)
  }

  @Test func delayedPasswordAfterQuitNeverReachesTheLogOrANewPasswordOffer() async throws {
    let (launch, cleanup) = try fakeScript("sleep 0.3\nprintf delayed_private_secret > \"$SHEPHERD_LOCAL_PASSWORD_FILE\"\nwhile :; do echo alive; sleep 0.1; done\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    first.terminateForQuit()
    let password = recordURL(launch).deletingPathExtension().appendingPathExtension("password")
    try await waitUntil { (try? String(contentsOf: password, encoding: .utf8)) == "delayed_private_secret" }
    let log = recordURL(launch).deletingPathExtension().appendingPathExtension("log")
    #expect(try !String(contentsOf: log, encoding: .utf8).contains("delayed_private_secret"))
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    #expect(await next.capturedPassword == nil)
    #expect(!FileManager.default.fileExists(atPath: password.path))
    await next.stop(gracePeriod: 0.3)
  }

  @Test func adoptionAndContinuousAppendLoggingBoundDiskAndHandleTruncation() async throws {
    let (launch, cleanup) = try fakeScript("while :; do echo continued; sleep 0.1; done\n")
    defer { cleanup() }
    let first = supervisor(launch)
    defer { first.terminateNow(gracePeriod: 0) }
    await first.start()
    first.terminateForQuit()
    let log = recordURL(launch).deletingPathExtension().appendingPathExtension("log")
    let writer = try FileHandle(forWritingTo: log)
    try writer.seekToEnd()
    try writer.write(contentsOf: Data(repeating: 120, count: Int(LocalServerLogTail.maxFileBytes) + 1))
    try writer.close()
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    try await waitUntil { await next.logLines().contains("continued") }
    let size = try FileManager.default.attributesOfItem(atPath: log.path)[.size] as? NSNumber
    #expect(try #require(size).uint64Value < LocalServerLogTail.maxFileBytes)
    let truncate = try FileHandle(forWritingTo: log)
    try truncate.truncate(atOffset: LocalServerLogTail.maxFileBytes + 1)
    try truncate.close()
    try await waitUntil {
      let size = try? FileManager.default.attributesOfItem(atPath: log.path)[.size] as? NSNumber
      return (size?.uint64Value ?? UInt64.max) < LocalServerLogTail.maxFileBytes
    }
    try await Task.sleep(for: .milliseconds(200))
    #expect(try String(contentsOf: log, encoding: .utf8).contains("continued"))
    await next.stop(gracePeriod: 0.3)
  }

  @Test func aRealParentExitPreservesStoppedAgentsThenAdoptsRecoversAndCleansUp() async throws {
    let (launch, cleanup) = try fakeScript("sleep 300 &\nagent=$!\nkill -STOP $agent\necho $agent > agent.pid\nwhile :; do echo continued; sleep 0.1; done\n")
    defer { cleanup() }
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let binary = try #require([".build/out/Products/Debug", ".build/debug"].map {
      package.appendingPathComponent($0 + "/LocalServerLifecycleHelper")
    }.first { FileManager.default.isExecutableFile(atPath: $0.path) })
    let helper = Process()
    helper.executableURL = binary
    helper.arguments = [launch.workingDirectory.path]
    helper.standardInput = FileHandle.nullDevice
    helper.standardOutput = FileHandle.nullDevice
    helper.standardError = FileHandle.nullDevice
    try helper.run()
    helper.waitUntilExit()
    #expect(helper.terminationStatus == 0)
    let record = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL(launch)))
    defer {
      if KernelProcessIdentity.read(record.pid) == record.processStart { killpg(record.processGroup, SIGKILL) }
    }
    let agentText = try String(contentsOf: launch.workingDirectory.appendingPathComponent("agent.pid"), encoding: .utf8)
    let agent = try #require(Int32(agentText.trimmingCharacters(in: .whitespacesAndNewlines)))
    try await Task.sleep(for: .milliseconds(250))
    #expect(processIsAlive(record.pid))
    #expect(processIsAlive(agent))
    var info = proc_bsdinfo()
    #expect(proc_pidinfo(record.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0)
    #expect(info.pbi_ppid != UInt32(helper.processIdentifier))
    let next = supervisor(launch)
    defer { next.terminateNow(gracePeriod: 0) }
    #expect(await next.adopt(healthyIdentity: record.identity))
    killpg(record.processGroup, SIGKILL)
    try await waitUntil { let state = await next.state; return state.isRunning && state.pid != record.pid }
    let replacement = try #require(await next.state.pid)
    #expect(processIsAlive(replacement))
    await next.stop(gracePeriod: 0.3)
    try await waitUntil { !processIsAlive(record.pid) && !processIsAlive(agent) && !processIsAlive(replacement) }
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
  }

}
#endif
