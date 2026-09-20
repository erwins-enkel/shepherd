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

  /// Test-only seam, mirroring `LocalServerSupervisor.testSeamAfterChildRun`:
  /// called synchronously between `process.run()` and publishing the pid, the
  /// one window in which a cancel finds nothing to kill. Production never sets
  /// it — it exists so a test can hold that window open instead of racing real
  /// threads for a gap a couple of instructions wide.
  var testSeamAfterRun: (@Sendable () -> Void)?

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
    // Register before launch: EOF can precede Foundation's exit notification.
    // waitUntilExit() after an await can block a cooperative worker indefinitely.
    let (exits, exitSignal) = AsyncStream<Int32>.makeStream()
    process.terminationHandler = { child in
      exitSignal.yield(child.terminationStatus)
      exitSignal.finish()
    }

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
      testSeamAfterRun?()
      livePID.withLock { $0 = process.processIdentifier }
      // The same window `LocalServerSupervisor` closes with its post-`spawn()`
      // epoch re-check: a cancel that landed between `run()` and the line above
      // found `nil`, did nothing, and left the installer to run to completion
      // uncancelled — mutating ~/.shepherd/app while the app was quitting.
      if Task.isCancelled { Self.terminate(process.processIdentifier, gracePeriod: 2) }

      await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in await log.append(line) }
      // A cancelled AsyncStream reader returns nil immediately. Keep this wait
      // in an independent task so cancellation still waits for the killed child
      // to be reaped before run() returns, without blocking a worker thread.
      let code = await Task {
        var exit = exits.makeAsyncIterator()
        return await exit.next()
      }.value
      livePID.withLock { $0 = nil }

      guard let code else { return .failure(.installFailed(exitCode: 127)) }
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
    // Read before the first signal: `getpgid` cannot answer for a reaped pid,
    // so asking again once the leader has gone returns -1 and the group — the
    // `bun install`, `git` and `curl` children `install.sh` spawned — escapes.
    let group = ownedGroup(of: pid)
    deliver(SIGTERM, to: pid)
    let deadline = Date().addingTimeInterval(gracePeriod)
    var leaderIsGone = false
    while Date() < deadline {
      if kill(pid, 0) != 0 {
        leaderIsGone = true
        break
      }
      usleep(20_000)
    }
    if !leaderIsGone { deliver(SIGKILL, to: pid) }
    // `install.sh` taking the SIGTERM says nothing about the descendants that
    // ignored it. Returning the moment the leader died is how they used to
    // outlive the app — and go on writing to ~/.shepherd/app.
    if let group { killpg(group, SIGKILL) }
  }

  private static func deliver(_ signalNumber: Int32, to pid: Int32) {
    if let group = ownedGroup(of: pid) {
      killpg(group, signalNumber)
    } else {
      kill(pid, signalNumber)
    }
  }

  /// The child's own process group, when it leads one that is not this app's.
  /// `nil` means there is no group of ours to signal, so only the pid may be.
  private static func ownedGroup(of pid: Int32) -> Int32? {
    let group = getpgid(pid)
    guard group == pid, group != getpgid(0) else { return nil }
    return group
  }
}
#endif
