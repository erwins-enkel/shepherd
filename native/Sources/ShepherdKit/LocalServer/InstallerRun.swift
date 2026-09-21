#if os(macOS)
import Foundation
import Synchronization
import os

/// Runs the checkout's `deploy/install.sh`, downloading the official bootstrap
/// when there is no readable checkout script. Output shares the server's log ring.
/// The script remains responsible for prerequisites and Bun provisioning. HOME,
/// install/DB paths and executable search paths come from the same resolved
/// environment as the supervised server; SHEPHERD_REF is preserved and
/// SHEPHERD_NO_SERVICE=1 selects the macOS core-only installation.
public struct InstallerRun: Sendable {
  private static let logger = Logger(subsystem: "run.shepherd.mac", category: "localserver")

  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let scriptOverride: URL?
  private let download: @Sendable (URLRequest) async throws -> (Data, URLResponse)
  public static let bootstrapURL = URL(string: "https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh")!

  /// Test-only seam, mirroring `LocalServerSupervisor.testSeamAfterChildRun`:
  /// called synchronously between `process.run()` and publishing the pid, the
  /// one window in which a cancel finds nothing to kill. Production never sets
  /// it — it exists so a test can hold that window open instead of racing real
  /// threads for a gap a couple of instructions wide.
  var testSeamAfterRun: (@Sendable () -> Void)?

  public init(
    environment: LocalServerEnvironment, log: LogRing, scriptOverride: URL? = nil,
    download: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = {
      try await URLSession.shared.data(for: $0)
    }
  ) {
    self.environment = environment
    self.log = log
    self.scriptOverride = scriptOverride
    self.download = download
  }

  /// Prefer a readable checkout installer; a cold install uses the official bootstrap.
  public var scriptURL: URL {
    scriptOverride ?? environment.appDirectory.appendingPathComponent("deploy/install.sh")
  }

  public func run() async -> Result<Void, LocalServerFailure> {
    guard !Task.isCancelled else { return .failure(.installFailed(exitCode: 130)) }
    var script = scriptURL
    var temporaryDirectory: URL?
    defer { if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) } }
    if !FileManager.default.isReadableFile(atPath: script.path) {
      if scriptOverride != nil {
        await log.append("installer not found at \(script.path)")
        return .failure(.installFailed(exitCode: 127))
      }
      await log.append("Downloading the official Shepherd installer…")
      var request = URLRequest(url: Self.bootstrapURL)
      request.timeoutInterval = 45
      request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      let data: Data
      do {
        let (body, response) = try await download(request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              http.url?.scheme == "https" else {
          await log.append("Installer download failed: expected a successful HTTPS response.")
          return .failure(.bootstrapDownload)
        }
        // A success status alone cannot distinguish a script from a proxy's HTML error page.
        guard body.starts(with: Data("#!/".utf8)), body.count <= 2_000_000 else {
          await log.append("Installer download was not a shell script.")
          return .failure(.bootstrapInvalid)
        }
        data = body
      } catch {
        await log.append("Installer download failed: \(error.localizedDescription)")
        return .failure(.bootstrapDownload)
      }
      do {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("shepherd-bootstrap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        temporaryDirectory = directory
        script = directory.appendingPathComponent("install.sh")
        try data.write(to: script, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: script.path)
      } catch {
        await log.append("Could not save the installer: \(error.localizedDescription)")
        return .failure(.bootstrapWrite)
      }
    }
    guard !Task.isCancelled else { return .failure(.installFailed(exitCode: 130)) }
    var childEnvironment = environment.childEnvironment()
    childEnvironment["SHEPHERD_NO_SERVICE"] = "1"
    await log.append("Running the Shepherd installer…")

    let pipe = Pipe()
    let process = Process()
    // /bin/bash explicitly: install.sh is `#!/usr/bin/env bash` and uses
    // bash-only syntax; the app must not depend on the operator's shell.
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [script.path]
    process.currentDirectoryURL = script.deletingLastPathComponent()
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
