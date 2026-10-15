import Foundation
import ShepherdKit

public enum EpicMeterTone: Sendable, Equatable { case merged, inFlight, rest }

/// The EPIC badge's meter (the web's `epicMeter`): one segment per child in epic order.
public enum EpicMeter {
    public static func tones(_ children: [EpicChild]) -> [EpicMeterTone] {
        children
            .sorted { $0.order != $1.order ? $0.order < $1.order : $0.number < $1.number }
            .map { $0.isMerged ? .merged : $0.isInFlight ? .inFlight : .rest }
    }

    /// The summary-only meter (EpicBadge without a live epic): merged first, the rest after.
    public static func tones(merged: Int, total: Int) -> [EpicMeterTone] {
        (0..<max(0, total)).map { $0 < merged ? .merged : .rest }
    }
}

public enum EpicClock {
    /// The epic clock (the web's `runMs`): `(pausedAt ?? landingStartedAt ?? now) − startedAt −
    /// pausedMs`; 0 before the first start.
    public static func runMs(_ timing: EpicTiming, now: Int) -> Int {
        guard let started = timing.startedAt else { return 0 }
        return max(0, (timing.pausedAt ?? timing.landingStartedAt ?? now) - started - timing.pausedMs)
    }
}
