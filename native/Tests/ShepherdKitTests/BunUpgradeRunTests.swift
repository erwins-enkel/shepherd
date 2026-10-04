#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized, .timeLimit(.minutes(1))) struct BunUpgradeRunTests {
  private func fakeBun(_ body: String) throws -> (URL, URL) {
    let home = try makeTempHome()
    let bun = home.appendingPathComponent("bun")
    try ("#!/bin/sh\n" + body).write(to: bun, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bun.path)
    return (bun, home)
  }

  @Test func successfulUpgradeStreamsOutputAndRechecksTheLocatedExecutable() async throws {
    let (bun, home) = try fakeBun("""
    if [ "$1" = --version ]; then echo 1.4.2; exit; fi
    echo "command=$1"
    echo "home=$HOME"
    echo "path=$PATH"
    echo "upgrade stderr" >&2
    """)
    defer { try? FileManager.default.removeItem(at: home) }
    let log = LogRing()
    let environment = LocalServerEnvironment(home: home)
    let run = BunUpgradeRun(environment: environment, log: log, executable: bun)
    #expect(await run.run() == .success("1.4.2"))
    let lines = await log.lines
    #expect(lines.contains("command=upgrade"))
    #expect(lines.contains("home=\(home.path)"))
    #expect(lines.contains("path=\(environment.childEnvironment(prepending: [home.path])["PATH"]!)"))
    #expect(lines.contains("upgrade stderr"))
  }

  @Test func failedUpgradeReportsExitAndSuccessStillBelowTheFloorFails() async throws {
    for (body, expected) in [
      ("exit 3", LocalServerFailure.bunUpgradeFailed(exitCode: 3)),
      ("if [ \"$1\" = --version ]; then echo 1.3.1; fi", .bunOutdated(version: "1.3.1")),
      ("if [ \"$1\" = --version ]; then echo unreadable; fi", .bunUpgradeFailed(exitCode: 127)),
    ] {
      let (bun, home) = try fakeBun(body)
      defer { try? FileManager.default.removeItem(at: home) }
      let result = await BunUpgradeRun(environment: LocalServerEnvironment(home: home), log: LogRing(), executable: bun).run()
      #expect(result == .failure(expected))
    }
  }

  @Test func timeoutKillsTheChildAndReports124() async throws {
    let (bun, home) = try fakeBun("echo pid=$$\nwhile true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: home) }
    let log = LogRing()
    let run = BunUpgradeRun(environment: LocalServerEnvironment(home: home), log: log, executable: bun, timeout: 0.2)
    #expect(await run.run() == .failure(.bunUpgradeFailed(exitCode: 124)))
    let line = try #require(await log.lines.first { $0.hasPrefix("pid=") })
    let pid = try #require(Int32(line.dropFirst(4)))
    #expect(!processIsAlive(pid))
    #expect(processesInGroup(pid).isEmpty)
  }

  @Test func cancellationReapsTheUpgradeAndItsChildren() async throws {
    let (bun, home) = try fakeBun("echo pid=$$\nwhile true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: home) }
    let log = LogRing()
    let run = BunUpgradeRun(environment: LocalServerEnvironment(home: home), log: log, executable: bun)
    let task = Task { await run.run() }
    try await waitUntil { await log.lines.contains { $0.hasPrefix("pid=") } }
    let line = try #require(await log.lines.first { $0.hasPrefix("pid=") })
    let pid = try #require(Int32(line.dropFirst(4)))
    task.cancel()
    #expect(await task.value == .failure(.bunUpgradeFailed(exitCode: 130)))
    #expect(!processIsAlive(pid))
    #expect(processesInGroup(pid).isEmpty)
  }

  @Test func cancellationBeforePidPublicationStillKillsTheUpgrade() async throws {
    let (bun, home) = try fakeBun("while true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: home) }
    var run = BunUpgradeRun(environment: LocalServerEnvironment(home: home), log: LogRing(), executable: bun)
    run.testSeamAfterRun = { withUnsafeCurrentTask { $0?.cancel() } }
    let task = Task { await run.run() }
    #expect(await task.value == .failure(.bunUpgradeFailed(exitCode: 130)))
  }
}
#endif
