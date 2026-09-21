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
