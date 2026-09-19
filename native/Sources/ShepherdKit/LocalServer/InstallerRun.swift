#if os(macOS)
import Foundation
import Synchronization
import os

/// Runs the repo's own `deploy/install.sh` and streams its output into the same
/// `LogRing` the server's output goes to, so the panel shows one continuous log.
/// The app never reimplements installer logic (design spec, sub-project 3). It
/// sets exactly the two values the macOS path needs:
///   SHEPHERD_NO_SERVICE=1  no systemd unit (install.sh sets this itself on
///                          Darwin; we set it too so a changed script cannot
///                          surprise us)
///   SHEPHERD_DIR           the same ~/.shepherd/app the supervisor will run in
/// `SHEPHERD_REF` is left alone: whatever the operator put in ~/.shepherd/env
/// wins, and the script's own default is `main`.
public struct InstallerRun: Sendable {
  private static let logger = Logger(subsystem: "run.shepherd.mac", category: "localserver")

  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let scriptOverride: URL?

  public init(environment: LocalServerEnvironment, log: LogRing, scriptOverride: URL? = nil) {
    self.environment = environment
    self.log = log
    self.scriptOverride = scriptOverride
  }

  /// `deploy/install.sh` inside the checkout. On a cold start there is none, so
  /// this fails with 127 and `LocalServerModel.install()` surfaces that — the
  /// app downloads nothing itself.
  public var scriptURL: URL {
    scriptOverride ?? environment.appDirectory.appendingPathComponent("deploy/install.sh")
  }

  public func run() async -> Result<Void, LocalServerFailure> {
    guard FileManager.default.isReadableFile(atPath: scriptURL.path) else {
      await log.append("installer not found at \(scriptURL.path)")
      return .failure(.installFailed(exitCode: 127))
    }
    guard !Task.isCancelled else { return .failure(.installFailed(exitCode: 127)) }

    var childEnvironment = ProcessInfo.processInfo.environment
    for (key, value) in environment.envFileValues() { childEnvironment[key] = value }
    // `appDirectory` is `<home>/.shepherd/app`; walking up two components gets
    // back to `home` without `LocalServerEnvironment` having to expose it.
    childEnvironment["HOME"] =
      environment.appDirectory.deletingLastPathComponent().deletingLastPathComponent().path
    childEnvironment["SHEPHERD_NO_SERVICE"] = "1"
    childEnvironment["SHEPHERD_DIR"] = environment.appDirectory.path

    let pipe = Pipe()
    let process = Process()
    // /bin/bash explicitly: install.sh is `#!/usr/bin/env bash` and uses
    // bash-only syntax; the app must not depend on the operator's shell.
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [scriptURL.path]
    process.currentDirectoryURL = scriptURL.deletingLastPathComponent()
    process.environment = childEnvironment
    process.standardOutput = pipe
    process.standardError = pipe

    // The child must be killable and never outlive the app: if the caller's Task
    // is cancelled — e.g. the app is quitting mid-install — `onCancel` fires,
    // possibly on another thread while `operation` is still running, so the
    // live pid lives in a `Mutex` rather than a local var. Signalling mirrors
    // `LocalServerSupervisor.deliver(_:to:)`: the child's whole process group
    // when it leads one (install.sh's own subprocesses die with it instead of
    // being reparented to launchd), the bare pid otherwise.
    let livePID = Mutex<Int32?>(nil)
    return await withTaskCancellationHandler {
      do { try process.run() } catch {
        await log.append("could not start the installer: \(error)")
        return .failure(.installFailed(exitCode: 127))
      }
      livePID.withLock { $0 = process.processIdentifier }

      await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in await log.append(line) }
      process.waitUntilExit()
      livePID.withLock { $0 = nil }

      let code = process.terminationStatus
      guard code == 0 else { return .failure(.installFailed(exitCode: code)) }
      Self.logger.info("installer finished")
      return .success(())
    } onCancel: {
      guard let pid = livePID.withLock({ $0 }) else { return }
      Self.terminate(pid, gracePeriod: 2)
    }
  }

  /// SIGTERM, then SIGKILL if the grace period elapses without the child dying.
  /// Synchronous and nonisolated so it can run from `withTaskCancellationHandler`'s
  /// `onCancel`, which gets no `await` — the same shape as
  /// `LocalServerSupervisor.terminateNow()`.
  private static func terminate(_ pid: Int32, gracePeriod: TimeInterval) {
    deliver(SIGTERM, to: pid)
    let deadline = Date().addingTimeInterval(gracePeriod)
    while Date() < deadline {
      if kill(pid, 0) != 0 { return }
      usleep(20_000)
    }
    deliver(SIGKILL, to: pid)
  }

  private static func deliver(_ signalNumber: Int32, to pid: Int32) {
    let group = getpgid(pid)
    if group == pid, group != getpgid(0) {
      killpg(group, signalNumber)
    } else {
      kill(pid, signalNumber)
    }
  }
}
#endif
