import Foundation

extension SessionStore {
  /// A live feed of every event this store applies, including the ones it does
  /// not model itself.
  ///
  /// One independent stream per call — several parallel streams tap the same
  /// store and each sees every frame. Buffered `.bufferingNewest(64)`: a tap
  /// consumer that stalls drops its own oldest frames rather than backing up
  /// the store's event loop for everybody. Every stream finishes on `stop()`,
  /// and a consumer that simply stops iterating removes its own tap.
  ///
  /// This is the seam parallel streams consume events through. A stream matches
  /// the raw name on `.unknown(name:payload:)` and decodes `payload` with the
  /// generated schema its own `contracts/openapi.yaml` block declares — the
  /// contract stays the only type source. Streams never add a case to
  /// `EventName` or edit `ServerEvent.swift`: that switch is exhaustive and
  /// S0-owned, so every stream that touched it would collide with every other.
  public func events() -> AsyncStream<ServerEvent> {
    let (stream, continuation) = AsyncStream<ServerEvent>.makeStream(
      bufferingPolicy: .bufferingNewest(64))
    // `stop()` already finished every continuation it knew about and will
    // never run again; a tap registered afterward would sit in `eventTaps`
    // with nothing left to broadcast to it or finish it, hanging the
    // caller's `for await` forever. Finish it on the spot instead, so the
    // stream a caller gets back is merely empty, not stuck.
    guard !stopped else {
      continuation.finish()
      return stream
    }
    let id = UUID()
    // Runs on whatever executor ended the stream (a cancelled consumer, a
    // dropped iterator), so it hops back before touching main-actor state.
    continuation.onTermination = { [weak self] _ in
      Task { @MainActor in self?.eventTaps[id] = nil }
    }
    eventTaps[id] = continuation
    return stream
  }

  /// Fans one applied event out to every tap. Called by `applyNow(_:)`.
  func broadcast(_ event: ServerEvent) {
    for continuation in eventTaps.values { continuation.yield(event) }
  }

  /// Ends every tap. Called by `stop()`.
  func finishEventTaps() {
    for continuation in eventTaps.values { continuation.finish() }
    eventTaps.removeAll()
  }
}
