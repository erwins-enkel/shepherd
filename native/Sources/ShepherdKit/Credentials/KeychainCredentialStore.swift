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

    // Add first, so a failing write never leaves a window with no stored
    // credential (delete-then-add would). `kSecAttrAccessible` is only
    // settable on add, so it is part of this query and not the update below.
    //
    // `…ThisDeviceOnly` states the intent: this token authenticates *this*
    // Mac to one server and has no business travelling. Nothing here sets
    // `kSecAttrSynchronizable`, so the item was never an iCloud Keychain
    // candidate either way — the suffix is what says so out loud, and what
    // keeps it out of an encrypted backup restored onto another machine.
    //
    // No `kSecUseDataProtectionKeychain`: that would need a keychain-sharing
    // entitlement the ad-hoc-signed development build does not have, so the
    // item lands in the legacy (file-based) keychain. That is a deliberate
    // trade, not an oversight; revisit it when the app ships signed with a
    // real team id.
    //
    // An item an earlier build already wrote keeps the accessibility it was
    // added with — the update path below only replaces the data. Logging out
    // deletes the item, so the next login re-adds it with this attribute.
    var attributes = baseQuery(for: key)
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let addStatus = SecItemAdd(attributes as CFDictionary, nil)
    if addStatus == errSecSuccess {
      ShepherdLog.credentials.debug("stored credential for \(key, privacy: .public)")
      return
    }
    guard addStatus == errSecDuplicateItem else {
      throw KeychainError.unexpectedStatus(addStatus)
    }

    // An item for this key already exists: update its data in place rather
    // than delete-then-add.
    let updateStatus = SecItemUpdate(
      baseQuery(for: key) as CFDictionary,
      [kSecValueData as String: data] as CFDictionary
    )
    guard updateStatus == errSecSuccess else {
      throw KeychainError.unexpectedStatus(updateStatus)
    }
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
