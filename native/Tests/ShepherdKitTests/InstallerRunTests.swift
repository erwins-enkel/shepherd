#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized) struct InstallerRunTests {
  /// `Result<Void, LocalServerFailure>` is not `Equatable` — `Void` isn't — so the
  /// brief's `== .success(())` / `== .failure(...)` comparisons are rewritten as
  /// pattern matches here instead of changing `InstallerRun.run()`'s return type.
  private func expectSuccess(_ result: Result<Void, LocalServerFailure>) {
    guard case .success = result else {
      Issue.record("expected .success, got \(result)")
      return
    }
  }

  private func expectFailure(_ result: Result<Void, LocalServerFailure>, _ expected: LocalServerFailure) {
    guard case .failure(let failure) = result else {
      Issue.record("expected .failure(\(expected)), got \(result)")
      return
    }
    #expect(failure == expected)
  }

  /// Stands in for deploy/install.sh: echoes what it was given, exits with the
  /// code the test asked for. No real install runs in this suite.
  private func fakeInstaller(exit code: Int32) throws -> (script: URL, home: URL) {
    let home = try makeTempHome()
    let script = home.appendingPathComponent("install.sh")
    try """
    #!/bin/bash
    echo "no-service=$SHEPHERD_NO_SERVICE"
    echo "dir=$SHEPHERD_DIR"
    exit \(code)
    """.write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return (script, home)
  }

  @Test func aSuccessfulRunStreamsItsOutputAndSucceeds() async throws {
    let (script, home) = try fakeInstaller(exit: 0)
    defer { try? FileManager.default.removeItem(at: home) }
    let log = LogRing(capacity: 50)
    let environment = LocalServerEnvironment(home: home)
    expectSuccess(
      await InstallerRun(environment: environment, log: log, scriptOverride: script).run())
    let lines = await log.lines
    #expect(lines.contains("no-service=1"))
    #expect(lines.contains("dir=\(environment.appDirectory.path)"))
  }

  @Test func aFailingRunReportsItsExitCode() async throws {
    let (script, home) = try fakeInstaller(exit: 3)
    defer { try? FileManager.default.removeItem(at: home) }
    let run = InstallerRun(
      environment: LocalServerEnvironment(home: home), log: LogRing(), scriptOverride: script)
    expectFailure(await run.run(), .installFailed(exitCode: 3))
  }

  @Test func aMissingScriptFailsCleanly() async throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let run = InstallerRun(
      environment: LocalServerEnvironment(home: home), log: LogRing(),
      scriptOverride: home.appendingPathComponent("nope.sh"))
    expectFailure(await run.run(), .installFailed(exitCode: 127))
  }

  /// Cancelling the enclosing `Task` must kill the child instead of leaving it to
  /// outlive the app — the same guarantee `LocalServerSupervisor.stop()` gives the
  /// server child, exercised here via `Task.cancel()` since `InstallerRun` exposes
  /// no `cancel()` of its own.
  @Test func aCancelledRunKillsItsChildAndDoesNotOutliveTheTask() async throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let script = home.appendingPathComponent("install.sh")
    try """
    #!/bin/bash
    echo "pid=$$"
    while true; do sleep 0.05; done
    """.write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

    let log = LogRing(capacity: 50)
    let environment = LocalServerEnvironment(home: home)
    let task = Task {
      await InstallerRun(environment: environment, log: log, scriptOverride: script).run()
    }

    var childPID: Int32?
    for _ in 0..<100 {
      if let line = await log.lines.first(where: { $0.hasPrefix("pid=") }) {
        childPID = Int32(line.dropFirst("pid=".count))
        break
      }
      try? await Task.sleep(for: .milliseconds(20))
    }
    let pid = try #require(childPID)

    task.cancel()
    _ = await task.value

    var stillAlive = true
    for _ in 0..<150 {
      if kill(pid, 0) != 0 {
        stillAlive = false
        break
      }
      try? await Task.sleep(for: .milliseconds(20))
    }
    #expect(!stillAlive)
  }
}
#endif
