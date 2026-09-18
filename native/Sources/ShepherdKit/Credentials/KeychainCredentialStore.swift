import Foundation
import Security

public enum KeychainError: Error, Equatable {
  /// `SecItem*` returned something other than `errSecSuccess` / `errSecItemNotFound`.
  case unexpectedStatus(OSStatus)
  /// The stored blob is not the JSON this store writes.
  case malformedItem
}

/// The real credential store: one `kSecClassGenericPassword` item per
/// profile, keyed by `service` + `credentialKey`. The design spec fixes the
/// rule — "Tokens only in the Keychain."
public struct KeychainCredentialStore: CredentialStore, Sendable {
  private let service: String

  public init(service: String = ShepherdLog.subsystem) {
    self.service = service
  }

  public func load(for key: String) throws -> StoredCredential? {
    var query = baseQuery(for: key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    guard let data = item as? Data else { throw KeychainError.malformedItem }
    do {
      return try JSONDecoder().decode(StoredCredential.self, from: data)
    } catch {
      throw KeychainError.malformedItem
    }
  }

  public func save(_ credential: StoredCredential, for key: String) throws {
    let data = try JSONEncoder().encode(credential)
    // Replace rather than update-or-add: a malformed leftover item would let
    // SecItemUpdate succeed while leaving undecodable bytes in place.
    try delete(for: key)

    var attributes = baseQuery(for: key)
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    ShepherdLog.credentials.debug("stored credential for \(key, privacy: .public)")
  }

  public func delete(for key: String) throws {
    let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.unexpectedStatus(status)
    }
  }

  private func baseQuery(for key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }
}
