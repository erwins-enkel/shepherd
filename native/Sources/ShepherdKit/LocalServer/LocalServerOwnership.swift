#if os(macOS)
import Foundation

/// A pid alone never grants ownership: adoption also checks its group, port,
/// installation directory and the unique identity returned by `/api/health`.
struct LocalServerOwnership: Codable, Sendable {
  let pid: Int32
  let processGroup: Int32
  let port: Int
  let spawnedAt: Date
  let executable: String
  let appDirectory: String
  let expectedIdentity: LocalServerIdentity
  var identity: LocalServerIdentity?
}

/// File output keeps working after the app closes its own descriptors. Reading
/// bounded chunks keeps both partial lines and catch-up memory bounded.
enum LocalServerLogTail {
  static func redact(_ secret: String, in url: URL) {
    let needle = Data(secret.utf8)
    guard !needle.isEmpty, let handle = try? FileHandle(forUpdating: url) else { return }
    defer { try? handle.close() }
    var carry = Data()
    var offset: UInt64 = 0
    while let chunk = try? handle.read(upToCount: ProcessOutputPump.maxPartialLineBytes), !chunk.isEmpty {
      let bytes = carry + chunk
      let base = offset - UInt64(carry.count)
      var start = bytes.startIndex
      while start < bytes.endIndex, let range = bytes.range(of: needle, in: start..<bytes.endIndex) {
        let replacement = [UInt8](repeating: UInt8(ascii: "*"), count: needle.count)
        _ = replacement.withUnsafeBytes {
          pwrite(handle.fileDescriptor, $0.baseAddress, $0.count, off_t(base + UInt64(range.lowerBound)))
        }
        start = range.upperBound
      }
      offset += UInt64(chunk.count)
      carry = Data(bytes.suffix(needle.count - 1))
    }
  }

  static func run(_ url: URL, onLine: (String) async -> Void) async {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return }
    defer { try? handle.close() }
    var partial: [UInt8] = []
    func flush() async {
      guard !partial.isEmpty else { return }
      if partial.last == UInt8(ascii: "\r") { partial.removeLast() }
      let line = String(decoding: partial, as: UTF8.self)
      partial.removeAll(keepingCapacity: true)
      await onLine(line)
    }
    // Drain once even if cancelled before this task started, so a short-lived
    // child still contributes its final output before the next log rotates.
    while true {
      let bytes: Data
      do { bytes = try handle.read(upToCount: ProcessOutputPump.maxPartialLineBytes) ?? Data() }
      catch { break }
      if bytes.isEmpty {
        if Task.isCancelled { break }
        do { try await Task.sleep(for: .milliseconds(100)) } catch { break }
        continue
      }
      for byte in bytes {
        if byte == UInt8(ascii: "\n") { await flush() }
        else {
          partial.append(byte)
          if partial.count >= ProcessOutputPump.maxPartialLineBytes { await flush() }
        }
      }
      if Task.isCancelled { break }
    }
    await flush()
  }
}
#endif
