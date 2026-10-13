#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized, .timeLimit(.minutes(1))) struct LocalRunnerStartTests {
  private func fixture(online: Bool, starts: Bool) throws -> (URL, LocalServerEnvironment) {
    let home = try makeTempHome()
    let binary = home.appendingPathComponent("fake runner")
    try """
    #!/bin/bash
    if [ "$1" = agent ]; then test -f "$HOME/live"; exit $?; fi
    echo "$*|$HERDR_SOCKET_PATH" >> "$HOME/calls"
    \(starts ? "touch \\\"$HOME/live\\\"" : "exit 1")
    """.replacingOccurrences(of: "\\\"", with: "\"").write(to: binary, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
    if online { try Data().write(to: home.appendingPathComponent("live")) }
    // A stale socket-shaped file is never evidence of a live daemon, nor removed.
    try Data("keep".utf8).write(to: home.appendingPathComponent("runner.sock"))
    return (home, LocalServerEnvironment(home: home, processEnvironment: [
      "PATH": "/usr/bin:/bin", "HERDR_BIN": binary.path,
      "HERDR_SOCKET_PATH": home.appendingPathComponent("runner.sock").path,
    ]))
  }

  @Test func liveDaemonIsANoOpAndStaleSocketStartsTheConfiguredBinary() async throws {
    for online in [true, false] {
      let (home, env) = try fixture(online: online, starts: true)
      defer { try? FileManager.default.removeItem(at: home) }
      let runner = LocalRunnerStart(environment: env, log: LogRing(), timeout: 1, pollInterval: 0.02)
      guard case .success = await runner.run() else { Issue.record("runner should answer"); continue }
      let calls = (try? String(contentsOf: home.appendingPathComponent("calls"), encoding: .utf8)) ?? ""
      #expect(calls == (online ? "" : "server|\(home.path)/runner.sock\n"))
      #expect(try String(contentsOf: home.appendingPathComponent("runner.sock"), encoding: .utf8) == "keep")
      guard case .success = await runner.run() else { Issue.record("second call should be idempotent"); continue }
      #expect((try? String(contentsOf: home.appendingPathComponent("calls"), encoding: .utf8)) ?? "" == calls)
    }
  }

  @Test func relativeSocketTargetsTheSameInstallPathFromHTTPDaemonAndProbe() async throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let install = home.appendingPathComponent("different install", isDirectory: true)
    let bin = home.appendingPathComponent("bin", isDirectory: true)
    try FileManager.default.createDirectory(at: install, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    let script = """
    #!/bin/bash
    printf '%s|%s\\n' "$1" "$HERDR_SOCKET_PATH" >> "$HOME/socket-calls"
    if [ "$1" = agent ]; then
      if [ ! -f "$HERDR_SOCKET_PATH.first-probe" ]; then
        : > "$HERDR_SOCKET_PATH.first-probe"
        exit 1
      fi
      # The real probe owns the authoritative 1.5s cancellation/kill bound.
      # This secondary pacing cap prevents a failed fixture from spinning.
      attempts=0
      while [ ! -f "$HERDR_SOCKET_PATH.ready" ] && [ "$attempts" -lt 140 ]; do
        sleep 0.01
        attempts=$((attempts + 1))
      done
      test -f "$HERDR_SOCKET_PATH.ready"
      exit $?
    fi
    if [ "$1" = server ]; then : > "$HERDR_SOCKET_PATH.ready"; fi
    """
    for name in ["bun", "herdr"] {
      let binary = bin.appendingPathComponent(name)
      try script.write(to: binary, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
    }
    let environment = LocalServerEnvironment(home: home, processEnvironment: [
      "PATH": "\(bin.path):/usr/bin:/bin", "SHEPHERD_DIR": install.path,
      "HERDR_BIN": bin.appendingPathComponent("herdr").path, "HERDR_SOCKET_PATH": "runner.sock",
    ])
    // Execute the real HTTP-child launch configuration with a harmless fake Bun.
    let launch = try #require(LocalServerSupervisor.defaultLaunch(environment)())
    let http = Process()
    http.executableURL = launch.executable
    http.arguments = launch.arguments
    http.currentDirectoryURL = launch.workingDirectory
    http.environment = launch.environment
    try http.run()
    http.waitUntilExit()
    #expect(http.terminationStatus == 0)
    let runner = LocalRunnerStart(environment: environment, log: LogRing(), timeout: 5, pollInterval: 0.02)
    let result = await runner.run()
    let calls = try String(contentsOf: home.appendingPathComponent("socket-calls"), encoding: .utf8)
      .split(separator: "\n").map(String.init)
    let expected = install.appendingPathComponent("runner.sock").path
    #expect(calls.contains("run|\(expected)"))
    #expect(calls.contains("server|\(expected)"))
    #expect(calls.contains("agent|\(expected)"))
    #expect(calls.allSatisfy { $0.hasSuffix("|\(expected)") })
    let callOrder = calls.prefix(4).map { call in
      switch call.split(separator: "|", maxSplits: 1).first {
      case "run": "run"
      case "server": "server"
      case "agent": "agent"
      default: "other"
      }
    }.joined(separator: ",")
    let readyMarker = FileManager.default.fileExists(
      atPath: install.appendingPathComponent("runner.sock.ready").path)
    guard case .success = result else {
      print("LocalRunnerStart probe failure result=failure ready=\(readyMarker) calls=\(callOrder)")
      Issue.record("probe must observe the daemon's socket")
      return
    }
    #expect(FileManager.default.fileExists(atPath: install.appendingPathComponent("runner.sock.ready").path))
    #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent("runner.sock.ready").path))
  }

  @Test func missingRunnerFailsWithoutLaunching() async throws {
    let home = try makeTempHome(); defer { try? FileManager.default.removeItem(at: home) }
    let runner = LocalRunnerStart(environment: LocalServerEnvironment(home: home, processEnvironment: [
      "HERDR_BIN": home.appendingPathComponent("missing").path,
    ]), log: LogRing(), start: { _, _ in Issue.record("must not launch") })
    guard case .failure(let failure) = await runner.run() else { Issue.record("must fail"); return }
    #expect(failure == .runnerMissing)
  }

  @Test func detachedRunnerWritesAfterItsParentExitsWithPrivateRotatedLog() async throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let binary = home.appendingPathComponent("fake runner")
    try """
    #!/bin/bash
    if [ "$1" = agent ]; then test -f "$HOME/runner.pid"; exit $?; fi
    echo $$ > "$HOME/runner.pid"
    while [ ! -f "$HOME/write-now" ]; do sleep 0.02; done
    echo 'stdout after parent exit'
    echo 'stderr after parent exit' >&2
    touch "$HOME/wrote"
    while :; do sleep 0.1; done
    """.write(to: binary, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
    let directory = home.appendingPathComponent(".shepherd/run")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let log = directory.appendingPathComponent("herdr-runner.log")
    try Data(repeating: UInt8(ascii: "x"), count: Int(LocalServerLogTail.maxFileBytes) + 1).write(to: log)
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let helperBinary = try #require([".build/out/Products/Debug", ".build/debug"].map {
      package.appendingPathComponent($0 + "/LocalServerLifecycleHelper")
    }.first { FileManager.default.isExecutableFile(atPath: $0.path) })
    let helper = Process()
    helper.executableURL = helperBinary
    helper.arguments = [home.path, "runner"]
    helper.standardInput = FileHandle.nullDevice
    helper.standardOutput = FileHandle.nullDevice
    helper.standardError = FileHandle.nullDevice
    try helper.run()
    helper.waitUntilExit()
    #expect(helper.terminationStatus == 0)
    let text = try String(contentsOf: home.appendingPathComponent("runner.pid"), encoding: .utf8)
    let pid = try #require(Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)))
    let identity = try #require(KernelProcessIdentity.read(pid))
    defer { if KernelProcessIdentity.read(pid) == identity { killpg(pid, SIGKILL) } }
    #expect(getpgid(pid) == pid)
    #expect(getpgid(pid) != getpgid(0))
    #expect(getpgid(pid) != getpgid(helper.processIdentifier))
    killpg(pid, SIGHUP)
    try Data().write(to: home.appendingPathComponent("write-now"))
    let deadline = ContinuousClock.now + .seconds(5)
    while !FileManager.default.fileExists(atPath: home.appendingPathComponent("wrote").path),
          ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
    #expect(KernelProcessIdentity.read(pid) == identity)
    #expect(try String(contentsOf: log, encoding: .utf8) == "stdout after parent exit\nstderr after parent exit\n")
    let permissions = try FileManager.default.attributesOfItem(atPath: log.path)
    #expect((permissions[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let previous = try FileManager.default.attributesOfItem(atPath: log.path + ".1")
    #expect((previous[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect((previous[.size] as? NSNumber)?.uint64Value == LocalServerLogTail.maxFileBytes)
  }

  @Test func startupFailureTimesOutWithoutDeletingExternalState() async throws {
    let (home, env) = try fixture(online: false, starts: false)
    defer { try? FileManager.default.removeItem(at: home) }
    let runner = LocalRunnerStart(environment: env, log: LogRing(), timeout: 0.1, pollInterval: 0.02)
    guard case .failure(let failure) = await runner.run() else { Issue.record("must fail"); return }
    #expect(failure == .runnerTimeout)
    #expect(try String(contentsOf: home.appendingPathComponent("runner.sock"), encoding: .utf8) == "keep")
  }
}
#endif
