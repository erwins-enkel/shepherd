#if os(macOS)
import Foundation
import Synchronization

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

  /// The line stood in for chunks a bounded `bufferingPolicy` threw away. A drop is a
  /// hole at an arbitrary byte — usually mid-line — so the bytes on either side of it
  /// are not one line and splicing them together would read as output the child never
  /// printed. The log says what it lost instead.
  public static func dropMarker(_ chunks: Int) -> String { "[log dropped \(chunks) chunks]" }

  /// Whether a line is one of this pump's own drop markers rather than child
  /// output. A consumer that joins fragments back together across the pump's
  /// line splits needs to tell the two apart — see
  /// `LocalServerSupervisor.ingest(_:)`.
  public static func isDropMarker(_ line: String) -> Bool {
    line.hasPrefix("[log dropped ") && line.hasSuffix(" chunks]")
  }

  /// `handle`'s readable bytes as ordered chunks, via `readabilityHandler` (see the
  /// type doc comment for why not `FileHandle.bytes`). `onTermination` detaches the
  /// handler when the consumer stops iterating, so the underlying `Pipe` deallocates
  /// and closes both descriptors.
  ///
  /// `bufferingPolicy` is the caller's: an installer run is bounded by the script
  /// itself and keeps every chunk, while a long-lived server the supervisor watches
  /// may log faster than the actor drains it and caps the buffer instead, dropping the
  /// oldest unread chunks so memory stays bounded rather than the operator's log.
  /// `onDrop` is how a bounded caller hears about that: it runs on the pipe's
  /// readability queue, so it must be cheap and thread-safe.
  public static func chunks(
    from handle: FileHandle,
    bufferingPolicy: AsyncStream<Data>.Continuation.BufferingPolicy = .unbounded,
    onDrop: (@Sendable () -> Void)? = nil
  ) -> AsyncStream<Data> {
    AsyncStream(Data.self, bufferingPolicy: bufferingPolicy) { continuation in
      handle.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {  // EOF: the child closed its end
          handle.readabilityHandler = nil
          continuation.finish()
        } else if case .dropped = continuation.yield(data) {
          onDrop?()
        }
      }
      continuation.onTermination = { _ in handle.readabilityHandler = nil }
    }
  }

  /// Reads whole lines out of `handle` until EOF, splitting on `"\n"` and stripping a
  /// trailing `"\r"`, calling `onLine` for each one — including a final line with no
  /// trailing newline. Invalid UTF-8 is repaired rather than dropped: child output is
  /// not ours to trust. Chunks a bounded `bufferingPolicy` dropped are reported in
  /// place, as a `dropMarker(_:)` line between the last line before the hole and the
  /// first one after it.
  public static func pump(
    _ handle: FileHandle,
    bufferingPolicy: AsyncStream<Data>.Continuation.BufferingPolicy = .unbounded,
    onLine: (String) async -> Void
  ) async {
    var partial: [UInt8] = []
    // Counted on the pipe's readability queue and read on this task, so it cannot be
    // a plain `var`: the two are different isolation domains.
    let dropped = Mutex<Int>(0)
    func flush() async {
      guard !partial.isEmpty else { return }
      var bytes = partial
      if bytes.last == UInt8(ascii: "\r") { bytes.removeLast() }
      let line = String(decoding: bytes, as: UTF8.self)
      partial.removeAll(keepingCapacity: true)
      await onLine(line)
    }
    func reportDrops() async {
      let lost = dropped.withLock { count -> Int in
        let value = count
        count = 0
        return value
      }
      guard lost > 0 else { return }
      // Whatever is buffered ends at the hole rather than being continued by the
      // bytes that come after it.
      await flush()
      await onLine(dropMarker(lost))
    }
    let stream = chunks(from: handle, bufferingPolicy: bufferingPolicy) {
      dropped.withLock { $0 += 1 }
    }
    for await chunk in stream {
      await reportDrops()
      for byte in chunk {
        if byte == UInt8(ascii: "\n") {
          await flush()
        } else {
          partial.append(byte)
          if partial.count >= maxPartialLineBytes { await flush() }
        }
      }
    }
    // Drops at the very end have no next chunk to be reported against.
    await reportDrops()
    await flush()  // whatever the child printed without a final newline
  }
}
#endif
