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
    if [ "$1" = agent ]; then test -f "$HERDR_SOCKET_PATH.ready"; exit $?; fi
    if [ "$1" = server ]; then touch "$HERDR_SOCKET_PATH.ready"; fi
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
    let runner = LocalRunnerStart(environment: environment, log: LogRing(), timeout: 0.2, pollInterval: 0.02)
    let result = await runner.run()
    let calls = try String(contentsOf: home.appendingPathComponent("socket-calls"), encoding: .utf8)
      .split(separator: "\n").map(String.init)
    let expected = install.appendingPathComponent("runner.sock").path
    #expect(calls.contains("run|\(expected)"))
    #expect(calls.contains("server|\(expected)"))
    #expect(calls.contains("agent|\(expected)"))
    #expect(calls.allSatisfy { $0.hasSuffix("|\(expected)") })
    guard case .success = result else { Issue.record("probe must observe the daemon's socket"); return }
    #expect(FileManager.default.fileExists(atPath: install.appendingPathComponent("runner.sock.ready").path))
    #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent("runner.sock.ready").path))
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
