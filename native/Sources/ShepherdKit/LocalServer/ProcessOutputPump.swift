#if os(macOS)
import Foundation

/// Turns one pipe's readable bytes into whole lines, one at a time, via a callback —
/// so a child process's merged stdout/stderr can be streamed into a `LogRing` without
/// going through `FileHandle.bytes`, which serializes every handle in the process onto
/// one reader and would starve a second pump parked on a different child's pipe.
/// `LocalServerSupervisor` and `InstallerRun` both stream a child's output this way;
/// this is the one place that buffering and line-splitting is written.
public enum ProcessOutputPump {
  /// A child that prints megabytes without a newline must not grow the pump's buffer
  /// without bound; at this size the partial line is flushed as-is.
  public static let maxPartialLineBytes = 64 * 1024

  /// `handle`'s readable bytes as ordered chunks, via `readabilityHandler` (see the
  /// type doc comment for why not `FileHandle.bytes`). `onTermination` detaches the
  /// handler when the consumer stops iterating, so the underlying `Pipe` deallocates
  /// and closes both descriptors.
  ///
  /// `bufferingPolicy` is the caller's: an installer run is bounded by the script
  /// itself and keeps every chunk, while a long-lived server the supervisor watches
  /// may log faster than the actor drains it and caps the buffer instead, dropping the
  /// oldest unread chunks so memory stays bounded rather than the operator's log.
  public static func chunks(
    from handle: FileHandle,
    bufferingPolicy: AsyncStream<Data>.Continuation.BufferingPolicy = .unbounded
  ) -> AsyncStream<Data> {
    AsyncStream(Data.self, bufferingPolicy: bufferingPolicy) { continuation in
      handle.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {  // EOF: the child closed its end
          handle.readabilityHandler = nil
          continuation.finish()
        } else {
          continuation.yield(data)
        }
      }
      continuation.onTermination = { _ in handle.readabilityHandler = nil }
    }
  }

  /// Reads whole lines out of `handle` until EOF, splitting on `"\n"` and stripping a
  /// trailing `"\r"`, calling `onLine` for each one — including a final line with no
  /// trailing newline. Invalid UTF-8 is repaired rather than dropped: child output is
  /// not ours to trust.
  public static func pump(
    _ handle: FileHandle,
    bufferingPolicy: AsyncStream<Data>.Continuation.BufferingPolicy = .unbounded,
    onLine: (String) async -> Void
  ) async {
    var partial: [UInt8] = []
    func flush() async {
      guard !partial.isEmpty else { return }
      var bytes = partial
      if bytes.last == UInt8(ascii: "\r") { bytes.removeLast() }
      let line = String(decoding: bytes, as: UTF8.self)
      partial.removeAll(keepingCapacity: true)
      await onLine(line)
    }
    for await chunk in chunks(from: handle, bufferingPolicy: bufferingPolicy) {
      for byte in chunk {
        if byte == UInt8(ascii: "\n") {
          await flush()
        } else {
          partial.append(byte)
          if partial.count >= maxPartialLineBytes { await flush() }
        }
      }
    }
    await flush()  // whatever the child printed without a final newline
  }
}
#endif
