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
    bunVersion: @escaping @Sendable (URL) async -> String? = { await LocalServerEnvironment.probeBunVersion($0) }
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
    // Built from the two patterns `LocalRunnerStart` already runs on CI: output is
    // drained by its own task (`launch`) and the exit is polled under a deadline
    // (`probeCommand`). A separate timer task plus an AsyncStream exit wait inside
    // the cancellation handler aborted Swift 6.3's runtime on the CI runners
    // ("freed pointer was not the last allocation").
    let shared = SharedState()
    process.terminationHandler = { child in shared.exitCode.withLock { $0 = child.terminationStatus } }
    let timeout = self.timeout
    let exit: ChildExit = await withTaskCancellationHandler {
      do { try process.run() } catch {
        await log.append("could not start bun upgrade: \(error)")
        return .notStarted
      }
      testSeamAfterRun?()
      let pid = process.processIdentifier
      shared.livePID.withLock { $0 = pid }
      if Task.isCancelled { Self.terminate(pid, gracePeriod: 2) }
      let output = Task { [log] in
        await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in await log.append(line) }
      }
      let deadline = Date().addingTimeInterval(timeout)
      while shared.exitCode.withLock({ $0 }) == nil {
        if Date() >= deadline, !shared.timedOut.withLock({ $0 }) {
          shared.timedOut.withLock { $0 = true }
          await log.append("bun upgrade timed out")
          Self.terminate(pid, gracePeriod: 2)
        }
        // A cancelled task's sleep throws at once; `onCancel` is already killing
        // the child, so back off briefly instead of spinning until it is reaped.
        do { try await Task.sleep(for: .milliseconds(50)) } catch { usleep(20_000) }
      }
      await output.value
      shared.livePID.withLock { $0 = nil }
      return .exited(shared.exitCode.withLock { $0 })
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
    let exitCode = Mutex<Int32?>(nil)
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
