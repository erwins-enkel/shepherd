#if os(macOS)
import Foundation
import Synchronization

/// Upgrades the located runtime, sharing the server's environment and log.
public struct BunUpgradeRun: Sendable {
  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let executable: URL?
  private let timeout: TimeInterval
  private let bunVersion: @Sendable (URL) async -> String?
  var testSeamAfterRun: (@Sendable () -> Void)?

  public init(
    environment: LocalServerEnvironment, log: LogRing, executable: URL? = nil,
    timeout: TimeInterval = 180,
    bunVersion: @escaping @Sendable (URL) async -> String? = LocalServerEnvironment.probeBunVersion
  ) {
    self.environment = environment
    self.log = log
    self.executable = executable
    self.timeout = timeout
    self.bunVersion = bunVersion
  }

  public func run() async -> Result<String, LocalServerFailure> {
    guard !Task.isCancelled else { return .failure(.bunUpgradeFailed(exitCode: 130)) }
    guard let bun = executable ?? environment.locateBun() else { return .failure(.bunMissing) }
    await log.append("Running bun upgrade…")
    let pipe = Pipe()
    let process = Process()
    process.executableURL = bun
    process.arguments = ["upgrade"]
    process.environment = environment.childEnvironment(prepending: [bun.deletingLastPathComponent().path])
    process.standardOutput = pipe
    process.standardError = pipe
    let (exits, exitSignal) = AsyncStream<Int32>.makeStream()
    process.terminationHandler = { child in
      exitSignal.yield(child.terminationStatus)
      exitSignal.finish()
    }
    // One Sendable reference for the timer task, the cancel handler and the run
    // body: capturing the two local `Mutex`es directly is rejected by Swift 6.3.
    let shared = SharedState()
    let timeout = self.timeout
    // The handler wraps only the child's lifetime; the version re-check runs after
    // it. Swift 6.3's task allocator aborts ("freed pointer was not the last
    // allocation") when a `defer`-cancelled timer task and further awaits share
    // the cancellation-handler closure, so neither lives in there.
    let exit: ChildExit = await withTaskCancellationHandler {
      do { try process.run() } catch {
        await log.append("could not start bun upgrade: \(error)")
        return .notStarted
      }
      testSeamAfterRun?()
      shared.livePID.withLock { $0 = process.processIdentifier }
      if Task.isCancelled { Self.terminate(process.processIdentifier, gracePeriod: 2) }
      let timer = Task {
        do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
        guard let pid = shared.livePID.withLock({ $0 }) else { return }
        shared.timedOut.withLock { $0 = true }
        await log.append("bun upgrade timed out")
        Self.terminate(pid, gracePeriod: 2)
      }
      await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in await log.append(line) }
      // An independent reader still reaps the child when this task is cancelled.
      let code = await Task {
        var exit = exits.makeAsyncIterator()
        return await exit.next()
      }.value
      timer.cancel()
      shared.livePID.withLock { $0 = nil }
      return .exited(code)
    } onCancel: {
      guard let pid = shared.livePID.withLock({ $0 }) else { return }
      Self.terminate(pid, gracePeriod: 2)
    }
    guard case .exited(let code) = exit else { return .failure(.bunUpgradeFailed(exitCode: 127)) }
    if Task.isCancelled { return .failure(.bunUpgradeFailed(exitCode: 130)) }
    if shared.timedOut.withLock({ $0 }) { return .failure(.bunUpgradeFailed(exitCode: 124)) }
    guard let code, code == 0 else { return .failure(.bunUpgradeFailed(exitCode: code ?? 127)) }
    guard let version = await bunVersion(bun), LocalServerEnvironment.bunVersionComponents(version) != nil else {
      await log.append("could not read Bun version after upgrade")
      return .failure(.bunUpgradeFailed(exitCode: 127))
    }
    guard !Task.isCancelled else { return .failure(.bunUpgradeFailed(exitCode: 130)) }
    if LocalServerEnvironment.bunTooOld(version) { return .failure(.bunOutdated(version: version)) }
    await log.append("Bun updated to \(version)")
    return .success(version)
  }

  private enum ChildExit: Sendable {
    case notStarted
    case exited(Int32?)
  }

  private final class SharedState: Sendable {
    let livePID = Mutex<Int32?>(nil)
    let timedOut = Mutex(false)
  }

  static func terminate(_ pid: Int32, gracePeriod: TimeInterval) {
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
    if let group { killpg(group, SIGKILL) }
  }

  private static func deliver(_ signalNumber: Int32, to pid: Int32) {
    if let group = ownedGroup(of: pid) {
      killpg(group, signalNumber)
    } else {
      kill(pid, signalNumber)
    }
  }

  private static func ownedGroup(of pid: Int32) -> Int32? {
    let group = getpgid(pid)
    guard group == pid, group != getpgid(0) else { return nil }
    return group
  }
}
#endif
