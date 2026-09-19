#if os(macOS)
import Foundation

/// A bounded, redacting buffer of child-process output. Bounded because a server
/// run for a day prints far more than a log disclosure should hold. Redacting
/// because the boot banner contains the operator password in clear text: once
/// told a secret, the ring scrubs it from what is already buffered **and** from
/// everything appended afterwards, so no later reader of `lines` can see it.
public actor LogRing {
  public static let placeholder = "••••"

  private var buffer: [String] = []
  private var secrets: [String] = []
  private let capacity: Int

  public init(capacity: Int = 500) { self.capacity = max(1, capacity) }

  public var lines: [String] { buffer }

  public func append(_ line: String) {
    buffer.append(scrub(line))
    if buffer.count > capacity { buffer.removeFirst(buffer.count - capacity) }
  }

  public func clear() { buffer.removeAll(keepingCapacity: true) }

  /// Registers `secret` and rewrites the existing buffer. Idempotent.
  public func redact(_ secret: String) {
    guard !secret.isEmpty, !secrets.contains(secret) else { return }
    secrets.append(secret)
    buffer = buffer.map { $0.replacingOccurrences(of: secret, with: Self.placeholder) }
  }

  private func scrub(_ line: String) -> String {
    secrets.reduce(line) { $0.replacingOccurrences(of: $1, with: Self.placeholder) }
  }
}
#endif
