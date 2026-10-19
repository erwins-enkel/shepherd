import Foundation
import ShepherdKit

@main
struct ShepherdPowerHelper {
    static func main() async {
        guard CommandLine.arguments.count == 5 else { exit(64) }
        let journalURL = URL(fileURLWithPath: CommandLine.arguments[2])
        let signals = [SIGTERM, SIGINT].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler {
                try? Data().write(to: journalURL.appendingPathExtension("resume"), options: .atomic)
            }
            source.resume()
            return source
        }
        defer { for source in signals { source.cancel() } }
        do {
            try await LocalBatteryPause.runHelper(
                ownershipURL: URL(fileURLWithPath: CommandLine.arguments[1]),
                journalURL: journalURL,
                runner: URL(fileURLWithPath: CommandLine.arguments[3]), socket: CommandLine.arguments[4])
        } catch { exit(1) }
    }
}
