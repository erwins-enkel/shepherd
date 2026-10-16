import Foundation
import ShepherdAppCore
import ShepherdKit

/// Copy shared by the epic header and the epic sheet.
@MainActor
enum IOSEpicCopy {
    static func state(_ child: EpicChild) -> String {
        switch IOSEpicStateDot.tone(child) {
        case .merged: L.t("epicflow_legend_merged")
        case .ready: L.t("epicflow_legend_ready")
        case .waiting: L.t("epicflow_legend_waiting")
        case .active: L.t(child.state.rawValue == "in-review" ? "epic_state_in_review" : "epic_state_running")
        }
    }

    /// The run's chip: "führt" while it runs, "pausiert" while paused, none when idle.
    static func runChip(_ epic: Epic) -> String? {
        switch epic.run.status.rawValue {
        case "running": L.t("epic_role_leading")
        case "paused": L.t("native_ios_epic_paused")
        default: nil
        }
    }

    static func clock(_ epic: Epic, now: Int) -> String? {
        guard let timing = epic.timing, timing.startedAt != nil else { return nil }
        let ms = EpicClock.runMs(timing, now: now)
        return L.t("native_ios_epic_since", IOSSessionListPresentation.elapsed(now - ms, now: now))
    }

    static func stage(_ digest: EpicDigest) -> String? {
        guard let stage = digest.flow.currentStage else { return nil }
        return L.t("native_ios_epic_stage", String(stage), String(digest.flow.stages.count))
    }

    static func forecast(_ epic: Epic, locale: Locale = .current) -> String? {
        guard let forecast = epic.forecast else { return nil }
        if let finish = forecast.finishAt {
            let when = Date(timeIntervalSince1970: Double(finish) / 1_000)
                .formatted(.dateTime.weekday(.abbreviated).hour().minute().locale(locale))
            return L.t("native_ios_epic_lands", when, confidence(forecast))
        }
        if let remaining = forecast.remainingMsFromResume {
            return L.t("native_ios_epic_remaining", IOSSessionListPresentation.elapsed(0, now: remaining))
        }
        return nil
    }

    /// The web's `confidenceWord`: marked when only the repo median backs it.
    static func confidence(_ forecast: EpicForecast) -> String {
        let word = switch forecast.confidence.rawValue {
        case "very-low": L.t("epic_tip_confidence_very_low")
        case "low": L.t("epic_tip_confidence_low")
        case "medium": L.t("epic_tip_confidence_medium")
        case "high": L.t("epic_tip_confidence_high")
        default: forecast.confidence.rawValue
        }
        return forecast.epicSamples == 0 ? L.t("epic_tip_confidence_repo_only", word) : word
    }
}
