#if os(macOS)
import Foundation

/// The app owns this channel outside the deployment so updates survive promotion/restart.
public struct LocalAppUpdateHandoff: Sendable {
  public let directory: URL
  public var requestURL: URL { directory.appendingPathComponent("update-request") }
  public var logURL: URL { directory.appendingPathComponent("shepherd-update.log") }

  public init(runDirectory: URL) {
    directory = runDirectory.appendingPathComponent("app-update", isDirectory: true)
  }

  public func prepare() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
  }

  /// Deletion is the claim: concurrent polls cannot execute the same request twice.
  public func claim() throws -> Bool {
    do {
      try FileManager.default.removeItem(at: requestURL)
      return true
    } catch CocoaError.fileNoSuchFile {
      return false
    }
  }

  public static func exitMarker(_ code: Int32) -> String { "__SHEPHERD_UPDATE_EXIT__:\(code)" }
}
#endif
