#if os(macOS)
import Foundation
import Synchronization

/// Applies the checkout update, sharing the supervised server's environment and log.
public struct LocalUpdateRun: Sendable {
  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let scriptOverride: URL?
  private let timeout: TimeInterval
  var testSeamAfterRun: (@Sendable () -> Void)?

  public init(
    environment: LocalServerEnvironment, log: LogRing, scriptOverride: URL? = nil,
    timeout: TimeInterval = 15 * 60
  ) {
    self.environment = environment
    self.log = log
    self.scriptOverride = scriptOverride
    self.timeout = timeout
  }

  public func run() async -> Result<Void, LocalServerFailure> {
    guard !Task.isCancelled else { return .failure(.updateFailed(exitCode: 130)) }
    let script = scriptOverride ?? environment.appDirectory.appendingPathComponent("deploy/update.sh")
    await log.append("Running the Shepherd backend update…")
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [script.path, "--pull"]
    process.currentDirectoryURL = environment.appDirectory
    var childEnvironment = environment.childEnvironment()
    childEnvironment["SHEPHERD_NO_SERVICE"] = "1"
    process.environment = childEnvironment
    process.standardOutput = pipe
    process.standardError = pipe
    // Keep BunUpgradeRun's Swift-6.3-safe shape: a termination handler,
    // an independent output pump and a polled exit under a deadline.
    let shared = SharedState()
    process.terminationHandler = { child in shared.exitCode.withLock { $0 = child.terminationStatus } }
    let timeout = self.timeout
    let exit: ChildExit = await withTaskCancellationHandler {
      do { try process.run() } catch {
        await log.append("could not start the backend update: \(error)")
        return .notStarted
      }
      testSeamAfterRun?()
      let pid = process.processIdentifier
      shared.livePID.withLock { $0 = pid }
      if Task.isCancelled { BunUpgradeRun.terminate(pid, gracePeriod: 2) }
      let output = Task { [log] in
        await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in await log.append(line) }
      }
      let deadline = Date().addingTimeInterval(timeout)
      while shared.exitCode.withLock({ $0 }) == nil {
        if Date() >= deadline, !shared.timedOut.withLock({ $0 }) {
          shared.timedOut.withLock { $0 = true }
          await log.append("backend update timed out")
          BunUpgradeRun.terminate(pid, gracePeriod: 2)
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
      BunUpgradeRun.terminate(pid, gracePeriod: 2)
    }
    guard case .exited(let code) = exit else { return .failure(.updateFailed(exitCode: 127)) }
    if Task.isCancelled { return .failure(.updateFailed(exitCode: 130)) }
    if shared.timedOut.withLock({ $0 }) { return .failure(.updateFailed(exitCode: 124)) }
    guard let code, code == 0 else { return .failure(.updateFailed(exitCode: code ?? 127)) }
    await log.append("Backend update finished")
    return .success(())
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

}
#endif
