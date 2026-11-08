#if os(macOS)
import Foundation

/// Tells the local server that a battery pause is about to suspend it, so Shepherds that have this
/// Mac connected show it as paused rather than unreachable. The file lives in the private
/// app↔server directory (`LocalAppUpdateHandoff.directory`); the server announces the pause on its
/// `/events` sockets and deletes the file — the deletion is the acknowledgement. Advisory only: the
/// pause never waits longer than `timeout`, and a server that does not answer (an older release)
/// just leaves its peers seeing a timeout, as before.
public struct LocalBatteryPauseNotice: Sendable {
  public let url: URL

  public init(directory: URL) {
    url = directory.appendingPathComponent("battery-pause")
  }

  /// True once the server took the notice; false when it could not be left or nobody took it in
  /// time — then it is withdrawn, so no later server announces a pause that is long over.
  @discardableResult
  public func announce(timeout: Duration = .milliseconds(1500),
                       poll: Duration = .milliseconds(50)) async -> Bool {
    let fileManager = FileManager.default
    guard fileManager.createFile(atPath: url.path, contents: Data()) else { return false }
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if !fileManager.fileExists(atPath: url.path) { return true }
      do { try await Task.sleep(for: poll) } catch { break }
    }
    try? fileManager.removeItem(at: url)
    return false
  }
}
#endif
