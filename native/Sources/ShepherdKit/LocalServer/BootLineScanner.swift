#if os(macOS)
import Foundation

/// The two lines of `bun run src/index.ts` output the app reacts to:
///   src/index.ts            `shepherd core on http://localhost:<port>`
///   src/operator-auth.ts    `  Operator password (shown ONCE): <pw>`
/// If either format changes, the supervisor falls back to the health poll for
/// readiness and simply never captures a password — degraded, not broken.
public enum BootLineScanner {
  public static func readyPort(in line: String) -> Int? {
    guard let range = line.range(of: "shepherd core on http://localhost:") else { return nil }
    let digits = line[range.upperBound...].prefix { $0.isNumber }
    return digits.isEmpty ? nil : Int(digits)
  }

  /// `generatePassword()` is `randomBytes(18).toString("base64url")` — 24 chars
  /// of `[A-Za-z0-9_-]` — so anything shorter is not it.
  public static func generatedPassword(in line: String) -> String? {
    guard let range = line.range(of: "Operator password (shown ONCE): ") else { return nil }
    let candidate = line[range.upperBound...]
      .prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    return candidate.count >= 20 ? String(candidate) : nil
  }
}
#endif
