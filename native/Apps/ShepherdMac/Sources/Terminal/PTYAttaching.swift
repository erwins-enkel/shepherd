import Foundation
import ShepherdKit

/// The terminal's view of a PTY socket, with every actor hop already taken.
///
/// `TerminalSessionModel` is a main-actor state machine; making it `await` the
/// actor directly would put a suspension in front of every transition and make
/// the unit tests race. This protocol is the seam: `LivePTYAttachment` wraps the
/// real `PTYConnection`, the tests substitute a hand-driven fake.
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

/// `PTYAttaching` over a real `PTYConnection`.
///
/// The kit's `output()` / `lifecycle()` are actor-isolated factories, so their
/// streams cannot be taken synchronously in `init`. This class therefore owns a
/// pair of main-actor streams and pumps the kit's into them. Both kit taps are
/// taken by one `taps` task, and **every** command chains onto that task: an
/// `.attached` yielded by a `start()` that overtook the tap registration would
/// be delivered to nobody, and the view would sit in "connecting" forever.
@MainActor
final class LivePTYAttachment: PTYAttaching {
    private let connection: PTYConnection
    let output: AsyncStream<Data>
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>

    private typealias Taps = (output: AsyncStream<Data>, lifecycle: AsyncStream<PTYConnection.LifecycleEvent>)
    private let taps: Task<Taps, Never>
    private let pumps: [Task<Void, Never>]

    init(client: ShepherdClient, sessionID: String, cols: Int, rows: Int) {
        let connection = PTYConnection(
            client: client, sessionID: sessionID, cols: cols, rows: rows)
        self.connection = connection
        // Same buffering policies the kit's own taps use: terminal output is
        // bursty, and a stalled consumer drops its own oldest chunks rather
        // than holding the socket's reader back.
        let (output, outputSink) = AsyncStream<Data>.makeStream(
            bufferingPolicy: .bufferingNewest(4096))
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
        pumps = [
            Task {
                for await bytes in await taps.value.output { outputSink.yield(bytes) }
                outputSink.finish()
            },
            Task {
                for await event in await taps.value.lifecycle { lifecycleSink.yield(event) }
                lifecycleSink.finish()
            },
        ]
    }

    func start() { command { await $0.start() } }
    /// The kit finishes every tap it handed out on `stop()`, which ends both
    /// pumps; cancelling them afterwards is the belt to that braces.
    func stop() {
        let pumps = self.pumps
        command {
            await $0.stop()
            for pump in pumps { pump.cancel() }
        }
    }
    func takeOver() { command { await $0.takeOver() } }
    func send(_ bytes: Data) { command { await $0.send(bytes) } }
    func resize(cols: Int, rows: Int) { command { await $0.resize(cols: cols, rows: rows) } }

    /// Runs `body` on the connection, never before the taps are registered.
    private func command(_ body: @escaping @Sendable (PTYConnection) async -> Void) {
        Task { [connection, taps] in
            _ = await taps.value
            await body(connection)
        }
    }
}
