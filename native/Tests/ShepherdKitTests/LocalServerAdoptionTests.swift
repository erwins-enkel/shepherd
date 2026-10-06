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
    launch.workingDirectory.appendingPathComponent("run/app-server.json")
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
    let logURL = launch.workingDirectory.appendingPathComponent("run/server.log")
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
    #expect(!FileManager.default.fileExists(atPath: recordURL(launch).path))
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
}
#endif
