#if os(macOS)
import Foundation

/// Reported install identity is consistency evidence, not proof that we own a process.
public struct LocalServerIdentity: Codable, Sendable, Equatable {
  public let appDirectory: String
  public let databasePath: String
  public let instanceID: String

  public init(appDirectory: String, databasePath: String, instanceID: String) {
    self.appDirectory = appDirectory
    self.databasePath = databasePath
    self.instanceID = instanceID
  }

  public init(_ metadata: Components.Schemas.LocalInstallIdentity) {
    self.init(appDirectory: metadata.appDirectory, databasePath: metadata.databasePath,
              instanceID: metadata.instanceID)
  }

  public func matches(_ other: LocalServerIdentity) -> Bool {
    !instanceID.isEmpty && instanceID == other.instanceID &&
      Self.canonical(appDirectory) == Self.canonical(other.appDirectory) &&
      Self.canonical(databasePath) == Self.canonical(other.databasePath)
  }

  private static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
  }
}
#endif
