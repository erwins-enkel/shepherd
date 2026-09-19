import Foundation

extension SessionStore {
  /// A live feed of every event this store applies, including the ones it does
  /// not model itself.
  ///
  /// One independent stream per call — several parallel streams tap the same
  /// store and each sees every frame. Buffered `.bufferingNewest(64)`: a tap
  /// consumer that stalls drops its own oldest frames rather than backing up
  /// the store's event loop for everybody. Every stream finishes on `stop()`.
  ///
  /// **Breaking out of `for await` does not end the tap — dropping the stream
  /// does.** Only two things unregister a tap: cancelling the task that is
  /// reading it, and releasing the `AsyncStream` value itself. Leaving the loop
  /// any other way — a `break`, a `return`, a `guard else` — drops the iterator
  /// and nothing else, so a stream kept in a property goes on collecting frames
  /// into a 64-slot buffer that nobody will ever read, for as long as the store
  /// runs. A consumer that stops reading must therefore drop the stream: hold
  /// it in an optional and nil it out, let it go out of scope, or cancel the
  /// reading task. `for await event in store.events() { … }` needs none of that
  /// — the temporary dies with the loop.
  ///
  /// The removal is not instantaneous: `onTermination` hops back to the main
  /// actor, so a frame or two may still be yielded into a buffer nobody reads.
  /// That is harmless — the buffer is bounded and is freed with the stream.
  ///
  /// **Reconcile after a gap.** A tap is not a guaranteed-complete log. It
  /// drops its own oldest frame past 64 buffered, `apply(_:)` drops the oldest
  /// past 256 while a snapshot load is in flight, and `EventStream` drops
  /// frames while a socket is down. Anything a stream derives from events must
  /// therefore be re-derivable from the store's own state, which every
  /// reconnect re-reads in full.
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
