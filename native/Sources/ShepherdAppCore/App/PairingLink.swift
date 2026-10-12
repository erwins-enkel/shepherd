import Foundation
import ShepherdKit

/// A scanned invitation, normalized by the same form parser and remote policy as typed addresses.
/// Kept out of descriptions and logs: `code` is a short-lived secret.
public struct PairingLink: Equatable, Sendable {
    public let baseURL: URL
    public let code: String

    public static func parse(_ string: String) -> PairingLink? {
        guard let url = URLComponents(string: string),
              url.scheme?.lowercased() == "shepherd", url.host?.lowercased() == "pair",
              url.path.isEmpty, url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil, let items = url.queryItems,
              items.count == 2,
              items.filter({ $0.name == "server" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              let server = items.first(where: { $0.name == "server" })?.value,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.hasPrefix("shpp_"), code.utf8.count == 48,
              code.dropFirst(5).utf8.allSatisfy({ byte in
                  (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 45 || byte == 95
              }),
              let baseURL = try? RemoteServerForm.normalize(server),
              (try? ServerProfile(name: "iPhone", baseURL: baseURL, mode: .remote).validated()) != nil
        else { return nil }
        return PairingLink(baseURL: baseURL, code: code)
    }
}
