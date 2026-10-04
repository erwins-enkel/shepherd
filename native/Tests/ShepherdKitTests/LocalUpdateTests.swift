#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized, .timeLimit(.minutes(1))) struct LocalUpdateTests {
  private func script(_ body: String) throws -> (URL, LocalServerEnvironment) {
    let home = try makeTempHome().resolvingSymlinksInPath()
    let environment = LocalServerEnvironment(home: home, pathEntries: ["/usr/bin", "/bin"], processEnvironment: [:])
    try FileManager.default.createDirectory(at: environment.appDirectory, withIntermediateDirectories: true)
    let file = environment.appDirectory.appendingPathComponent("fake-update.sh")
    try ("#!/bin/bash\n" + body).write(to: file, atomically: true, encoding: .utf8)
    return (file, environment)
  }

  @Test func parserKeepsCountSHAsDateAndBoundedSubjects() throws {
    let date = Date(timeIntervalSince1970: 123)
    let lines = ["12", "abc1234", "def5678"] + (0..<12).map { _ in "def5678\t" + String(repeating: "x", count: 400) }
    let status = try #require(LocalUpdateCheck.parse(lines, checkedAt: date))
    #expect(status.behind == 12)
    #expect(status.current == "abc1234" && status.latest == "def5678")
    #expect(status.checkedAt == date)
    #expect(status.commits.count == 10)
    #expect(status.commits.allSatisfy { $0.subject.count == 300 })
    #expect(LocalUpdateCheck.parse(["0", "abc1234", "abc1234"], checkedAt: date)?.behind == 0)
  }

  @Test func parserRejectsMalformedOrInconsistentOutput() {
    for lines in [["garbled"], ["-1", "abc1234", "def5678"], ["1", "bad-sha", "def5678"],
                  ["1", "abc1234", "def5678", "not a commit"], ["0", "abc1234", "def5678", "def5678\tsubject"]] {
      #expect(LocalUpdateCheck.parse(lines, checkedAt: Date()) == nil)
    }
  }

  @Test func checkUsesCheckoutEnvironmentAndParsesScriptOutput() async throws {
    let (file, environment) = try script("""
      [ "$PWD" -ef "$SHEPHERD_DIR" ] && [ "$HOME/.shepherd/app" -ef "$PWD" ] || exit 9
      [ "$GIT_TERMINAL_PROMPT" = 0 ] || exit 8
      echo 2
      echo abc1234
      echo def5678
      printf 'def5678\tNewest commit\nabc9999\tEarlier commit\n'
      """)
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let result = await LocalUpdateCheck(environment: environment, scriptOverride: file).run()
    guard case .success(let status) = result else { Issue.record("check failed: \(result)"); return }
    #expect(status.behind == 2)
    #expect(status.commits.map(\.subject) == ["Newest commit", "Earlier commit"])
  }

  @Test func checkFetchesMainFromALocalOrigin() async throws {
    let (file, environment) = try script("""
      set -e
      git init -q -b main origin
      cd origin
      git config user.email test@example.invalid
      git config user.name Test
      git config commit.gpgsign false
      echo first > file
      git add file
      git commit -qm first
      cd ..
      git clone -q origin checkout
      cd origin
      echo second >> file
      git commit -qam second
      """)
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [file.path]
    process.currentDirectoryURL = environment.appDirectory
    process.environment = environment.childEnvironment()
    try process.run()
    process.waitUntilExit() // Finite, local fixture setup; never a production runner.
    #expect(process.terminationStatus == 0)
    let checkout = environment.appDirectory.appendingPathComponent("checkout")
    let checkedEnvironment = LocalServerEnvironment(home: environment.homeDirectory,
      pathEntries: ["/usr/bin", "/bin"], processEnvironment: ["SHEPHERD_DIR": checkout.path])
    guard case .success(let status) = await LocalUpdateCheck(environment: checkedEnvironment).run() else {
      Issue.record("git check failed"); return
    }
    #expect(status.behind == 1)
    #expect(status.current != status.latest)
    #expect(status.commits.map(\.subject) == ["second"])
  }

  @Test func checkReportsFailureInvalidOutputAndTimeout() async throws {
    for (body, timeout, expected) in [
      ("exit 7", 5.0, LocalUpdateCheckFailure.commandFailed(exitCode: 7)),
      ("echo invalid", 5.0, .invalidOutput),
      ("while true; do sleep 0.05; done", 0.2, .commandFailed(exitCode: 124)),
    ] {
      let (file, environment) = try script(body)
      defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
      #expect(await LocalUpdateCheck(environment: environment, timeout: timeout, scriptOverride: file).run() == .failure(expected))
    }
  }

  @Test func checkCancellationBeforePIDPublicationReapsItsGroup() async throws {
    let (file, environment) = try script("echo $$ > pid\nwhile true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    var check = LocalUpdateCheck(environment: environment, scriptOverride: file)
    check.testSeamAfterRun = { withUnsafeCurrentTask { $0?.cancel() } }
    let task = Task { await check.run() }
    #expect(await task.value == .failure(.commandFailed(exitCode: 130)))
  }

  @Test func applyUsesPullFlagEnvironmentWorkingDirectoryAndSharedLog() async throws {
    let (file, environment) = try script("""
      echo "argument=$1"
      echo "home=$HOME"
      echo "cwd=$PWD"
      echo "path=$PATH"
      echo "no-service=$SHEPHERD_NO_SERVICE"
      echo 'build output' >&2
      """)
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let log = LogRing()
    let result = await LocalUpdateRun(environment: environment, log: log, scriptOverride: file).run()
    guard case .success = result else { Issue.record("apply failed: \(result)"); return }
    let lines = await log.lines
    #expect(lines.contains("argument=--pull"))
    #expect(lines.contains("home=\(environment.homeDirectory.path)"))
    let cwd = try #require(lines.first { $0.hasPrefix("cwd=") })
    #expect(URL(fileURLWithPath: String(cwd.dropFirst(4))).resolvingSymlinksInPath()
      == environment.appDirectory.resolvingSymlinksInPath())
    #expect(lines.contains("path=\(environment.childEnvironment()["PATH"]!)"))
    #expect(lines.contains("no-service=1"))
    #expect(lines.contains("build output"))
  }

  @Test func applyReportsDirtyTreeFailureWithoutDiscarding() async throws {
    let (file, environment) = try script("echo '--pull needs a clean tree' >&2\nexit 1")
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let log = LogRing()
    let result = await LocalUpdateRun(environment: environment, log: log, scriptOverride: file).run()
    guard case .failure(let failure) = result else { Issue.record("unexpected success"); return }
    #expect(failure == .updateFailed(exitCode: 1))
    #expect(await log.lines.contains("--pull needs a clean tree"))
  }

  @Test func applyTimeoutKillsTheChildAndItsDescendants() async throws {
    let (file, environment) = try script("echo pid=$$\nwhile true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let log = LogRing()
    let result = await LocalUpdateRun(environment: environment, log: log, scriptOverride: file, timeout: 0.2).run()
    guard case .failure(let failure) = result else { Issue.record("unexpected success"); return }
    #expect(failure == .updateFailed(exitCode: 124))
    let line = try #require(await log.lines.first { $0.hasPrefix("pid=") })
    let pid = try #require(Int32(line.dropFirst(4)))
    #expect(!processIsAlive(pid))
    #expect(processesInGroup(pid).isEmpty)
  }

  @Test func applyCancellationReapsTheChildAndItsDescendants() async throws {
    let (file, environment) = try script("echo pid=$$\nwhile true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let log = LogRing()
    let run = LocalUpdateRun(environment: environment, log: log, scriptOverride: file)
    let task = Task { await run.run() }
    try await waitUntil { await log.lines.contains { $0.hasPrefix("pid=") } }
    let line = try #require(await log.lines.first { $0.hasPrefix("pid=") })
    let pid = try #require(Int32(line.dropFirst(4)))
    task.cancel()
    guard case .failure(let failure) = await task.value else { Issue.record("unexpected success"); return }
    #expect(failure == .updateFailed(exitCode: 130))
    #expect(!processIsAlive(pid))
    #expect(processesInGroup(pid).isEmpty)
  }

  @Test func applyCancellationBeforePIDPublicationStillKillsTheChild() async throws {
    let (file, environment) = try script("while true; do sleep 0.05; done")
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    var run = LocalUpdateRun(environment: environment, log: LogRing(), scriptOverride: file)
    run.testSeamAfterRun = { withUnsafeCurrentTask { $0?.cancel() } }
    let task = Task { await run.run() }
    guard case .failure(let failure) = await task.value else { Issue.record("unexpected success"); return }
    #expect(failure == .updateFailed(exitCode: 130))
  }
}
#endif
