import Foundation
import ShepherdKit

/// The terminal's view of a PTY socket, with every actor hop already taken.
///
/// `TerminalSessionModel` is a main-actor state machine; making it `await` the
/// actor directly would put a suspension in front of every transition and make
/// the unit tests race. This protocol is the seam: `LivePTYAttachment` wraps the
/// real `PTYConnection`, the tests substitute a hand-driven fake.
///
/// `stop()` is **terminal** for an instance: an attachment that has been stopped
/// never starts again, and the model builds a new one instead.
@MainActor
protocol PTYAttaching: AnyObject {
    func start()
    func stop()
    func takeOver()
    func send(_ bytes: Data)
    func resize(cols: Int, rows: Int)
    var output: AsyncStream<Data> { get }
    var lifecycle: AsyncStream<PTYConnection.LifecycleEvent> { get }
}

/// Runs connection commands one at a time, in the order they were issued.
///
/// Unstructured `Task`s are *not* FIFO. A `takeOver()` issued just before a
/// `detach()` can therefore run *after* the `stop()` it was meant to precede,
/// which reopens the socket with nobody tapping it — the view then sits in
/// "connecting" for ever. One stream, one consumer, one order.
@MainActor
final class PTYCommandQueue {
    private let sink: AsyncStream<@Sendable () async -> Void>.Continuation
    private let runner: Task<Void, Never>

    /// `prologue` runs once before the first command: the taps have to be
    /// registered before anything can make the connection emit. `epilogue` runs
    /// once, after `finish()` and after the queue has drained.
    init(
        prologue: @escaping @Sendable () async -> Void,
        epilogue: @escaping @Sendable () -> Void
    ) {
        let (stream, sink) = AsyncStream<@Sendable () async -> Void>.makeStream(
            bufferingPolicy: .unbounded)
        self.sink = sink
        runner = Task {
            await prologue()
            for await command in stream { await command() }
            epilogue()
        }
    }

    func enqueue(_ command: @escaping @Sendable () async -> Void) { sink.yield(command) }

    /// Closes the queue: anything enqueued afterwards is dropped. `stop()` is
    /// the last command an attachment ever issues, so this is where it belongs.
    func finish() { sink.finish() }

    /// Drops whatever is still queued and cancels the consumer. `nonisolated`
    /// because `LivePTYAttachment.deinit` is the caller and a deinit cannot hop
    /// to the main actor; both stored properties are `let`s of `Sendable` type.
    nonisolated func cancel() {
        sink.finish()
        runner.cancel()
    }
}

/// Drains `source` into `sink`, oldest first, finishing `sink` once `source`
/// finishes. Extracted from the output/lifecycle wiring below so the "never
/// drop" guarantee is directly testable: hand it a hand-fed source and an
/// `.unbounded` sink, and a burst that outruns a slow consumer still arrives
/// complete and in order — which is exactly the contract `LivePTYAttachment`'s
/// output relay now relies on.
@MainActor
func pump<Element: Sendable>(
    from source: AsyncStream<Element>, into sink: AsyncStream<Element>.Continuation
) async {
    for await element in source { sink.yield(element) }
    sink.finish()
}

/// `PTYAttaching` over a real `PTYConnection`.
///
/// The kit's `output()` / `lifecycle()` are actor-isolated factories, so their
/// streams cannot be taken synchronously in `init`. This class therefore owns a
/// pair of main-actor streams and pumps the kit's into them. Both kit taps are
/// taken by one `taps` task, which is the queue's prologue: an `.attached`
/// yielded by a `start()` that overtook the tap registration would be delivered
/// to nobody.
@MainActor
final class LivePTYAttachment: PTYAttaching {
    private let connection: PTYConnection
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>

    private typealias Taps = (
        output: AsyncStream<Data>, lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    )
    private let taps: Task<Taps, Never>
    private let pumps: [Task<Void, Never>]
    private let commands: PTYCommandQueue

    init(client: ShepherdClient, sessionID: String, cols: Int, rows: Int) {
        let connection = PTYConnection(
            client: client, sessionID: sessionID, cols: cols, rows: rows)
        self.connection = connection
        // `output` is `.unbounded`, unlike the kit's own tap: terminal bytes
        // must never drop once they have left the kit's tap — a lost chunk
        // mid-escape garbles the emulator — and the main actor that owns this
        // relay always drains it, so there is nothing here for a bounded
        // buffer to protect. `lifecycle` keeps the kit's own bursty-consumer
        // policy: a handful of status events, not a data stream.
        let (output, outputSink) = AsyncStream<Data>.makeStream(bufferingPolicy: .unbounded)
        let (lifecycle, lifecycleSink) = AsyncStream<PTYConnection.LifecycleEvent>.makeStream(
            bufferingPolicy: .bufferingNewest(16))
        self.output = output
        self.lifecycle = lifecycle
        // Taken once, here: both kit streams are per-call, so a second call
        // would register a second tap rather than hand back this one.
        let taps = Task { [connection] () -> Taps in
            (output: await connection.output(), lifecycle: await connection.lifecycle())
        }
        self.taps = taps
        let pumps = [
            Task { await pump(from: taps.value.output, into: outputSink) },
            Task { await pump(from: taps.value.lifecycle, into: lifecycleSink) },
        ]
        self.pumps = pumps
        // The kit finishes every tap it handed out on `stop()`, which ends both
        // pumps; cancelling them once the queue has drained is the belt to that
        // braces.
        commands = PTYCommandQueue(
            prologue: { _ = await taps.value },
            epilogue: { for pump in pumps { pump.cancel() } })
    }

    /// A dropped attachment must not leave a socket reconnecting behind it:
    /// nothing else holds the connection, so nothing else would ever stop it.
    deinit {
        commands.cancel()
        taps.cancel()
        for pump in pumps { pump.cancel() }
        let connection = self.connection
        Task { await connection.stop() }
    }

    func start() {
        let connection = self.connection
        commands.enqueue { await connection.start() }
    }

    /// Terminal for this instance: the queue closes behind the stop, so no
    /// later command can reopen the socket.
    func stop() {
        let connection = self.connection
        commands.enqueue { await connection.stop() }
        commands.finish()
    }

    func takeOver() {
        let connection = self.connection
        commands.enqueue { await connection.takeOver() }
    }

    func send(_ bytes: Data) {
        let connection = self.connection
        commands.enqueue { await connection.send(bytes) }
    }

    func resize(cols: Int, rows: Int) {
        let connection = self.connection
        commands.enqueue { await connection.resize(cols: cols, rows: rows) }
    }
}
