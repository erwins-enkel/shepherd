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
    // The loopback/tailnet exceptions below only ever loosen `https` to
    // plain `http`; they are not a license for an unrelated protocol. A
    // missing scheme (a "//host" reference) or anything other than http(s)
    // (e.g. `ftp`) is rejected outright, before either exception applies.
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
      throw ServerProfileError.insecureRemoteURL(host)
    }
    if scheme == "https" { return }
    if isLoopback(host) { return }
    // A fully-qualified tailnet name ends in a trailing DNS root dot
    // ("mini.tail1234.ts.net."); strip at most one before the suffix check
    // so that form is still recognised.
    var withoutRootDot = host
    if withoutRootDot.hasSuffix(".") { withoutRootDot.removeLast() }
    // `.ts.net` with the leading dot, so "evilts.net" and a bare "ts.net"
    // do not pass as tailnet names.
    if withoutRootDot.lowercased().hasSuffix(".ts.net") { return }
    throw ServerProfileError.insecureRemoteURL(host)
  }

  /// Returns `self` when the profile satisfies the policy, throws otherwise.
  @discardableResult
  public func validated() throws -> ServerProfile {
    if mode == .remote { try Self.requireSecureRemote(baseURL) }
    return self
  }

  private static func isLoopback(_ host: String) -> Bool {
    // `host(percentEncoded:)` already strips a bracketed IPv6 literal's
    // brackets, but the trim stays as a defensive no-op for any caller that
    // hands this a raw, still-bracketed string.
    let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
    if bare == "localhost" || bare == "::1" || bare == "0:0:0:0:0:0:0:1" { return true }
    return isLoopbackIPv4(bare)
  }

  /// The whole 127.0.0.0/8 block, not just 127.0.0.1 — RFC 5735 reserves all
  /// of it for loopback, and local tooling (e.g. sandboxed proxies) sometimes
  /// binds to another address in the block.
  private static func isLoopbackIPv4(_ host: String) -> Bool {
    guard host.hasPrefix("127.") else { return false }
    let octets = host.split(separator: ".", omittingEmptySubsequences: false)
    return octets.count == 4 && octets.allSatisfy { UInt8($0) != nil }
  }
}
