import Foundation

/// Why a profile's base URL is not acceptable.
public enum ServerProfileError: Error, Equatable, Sendable {
  /// A `.remote` profile used plain http to a host that is neither loopback
  /// nor a tailnet name. The associated value is the offending host.
  case insecureRemoteURL(String)
  /// The URL has no host component at all.
  case missingHost
}

/// One server the app can talk to. Replaces the web UI's same-origin
/// assumption: the app keeps any number of these and one is active.
public struct ServerProfile: Codable, Hashable, Sendable, Identifiable {
  public enum Mode: String, Codable, Hashable, Sendable {
    /// A server this Mac runs (sub-project 3 supervises it).
    case local
    /// A server reached over the network.
    case remote
  }

  public let id: UUID
  public var name: String
  public var baseURL: URL
  public var mode: Mode
  /// Keychain account name for this profile's access token.
  public var credentialKey: String

  public init(
    id: UUID = UUID(),
    name: String,
    baseURL: URL,
    mode: Mode,
    credentialKey: String? = nil
  ) {
    self.id = id
    self.name = name
    self.baseURL = baseURL
    self.mode = mode
    self.credentialKey = credentialKey ?? "profile.\(id.uuidString)"
  }

  /// The security policy from the design spec: "Remote profiles require
  /// `https` unless the host is loopback or a `.ts.net` name."
  ///
  /// A `.local` profile is exempt because sub-project 3 binds that server to
  /// loopback itself.
  public static func requireSecureRemote(_ url: URL) throws {
    guard let host = url.host(percentEncoded: false), !host.isEmpty else {
      throw ServerProfileError.missingHost
    }
    if url.scheme?.lowercased() == "https" { return }
    if isLoopback(host) { return }
    // `.ts.net` with the leading dot, so "evilts.net" and a bare "ts.net"
    // do not pass as tailnet names.
    if host.lowercased().hasSuffix(".ts.net") { return }
    throw ServerProfileError.insecureRemoteURL(host)
  }

  /// Returns `self` when the profile satisfies the policy, throws otherwise.
  @discardableResult
  public func validated() throws -> ServerProfile {
    if mode == .remote { try Self.requireSecureRemote(baseURL) }
    return self
  }

  private static func isLoopback(_ host: String) -> Bool {
    let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    return bare == "localhost" || bare == "127.0.0.1" || bare == "::1"
  }
}
