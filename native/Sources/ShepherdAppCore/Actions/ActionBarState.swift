import Observation
import ShepherdKit
import SwiftUI

/// The web's recap verdict chip plus its headline — the "Handlungsbedarf" line.
///
/// The derivation is a static function over a value rather than a computed property on the
/// view, so the three interesting cases (no recap, a recap still generating, a verdict this
/// build has never heard of) are assertable without hosting SwiftUI.
public enum RecapLine {
    public struct Content: Equatable, Sendable {
        public let verdict: String
        public let headline: String
        public let openItems: Int
    }

    /// `nil` when there is nothing worth a line: no recap at all, or one whose headline is still
    /// empty because it has not finished generating.
    public static func content(for recap: Recap?) -> Content? {
        guard let recap, !recap.headline.isEmpty else { return nil }
        return Content(
            verdict: label(for: recap.verdict),
            headline: recap.headline,
            openItems: recap.openItems.count)
    }

    /// An open enum: a verdict this build does not know still renders, as its raw wire value,
    /// rather than vanishing.
    private static func label(for verdict: RecapVerdict?) -> String {
        guard let verdict else { return "" }
        switch verdict.known {
        case .ready: return L.t("recap_verdict_ready")
        case .parked: return L.t("recap_verdict_parked")
        case .needsAttention: return L.t("recap_verdict_needs_attention")
        case nil: return verdict.rawValue
        }
    }

    public static func tint(for verdict: RecapVerdict?) -> Color {
        switch verdict?.known {
        case .ready: .green
        case .needsAttention: .orange
        case .parked: .secondary
        default: .secondary
        }
    }
}

/// One line the bar shows above the recap, and how it should read.
///
/// The bar is the one surface in the app that reports success as well as failure — "Stopped
/// TASK-07", "Renamed…", "Relaunched as TASK-08" — so the text alone is not enough: rendered in
/// `NoticeBar`'s default chrome every one of them arrived under a warning triangle. Pairing the
/// text with its `NoticeTone` at the point the outcome is known keeps the decision where the
/// outcome is, rather than in the view body.
public struct ActionNote: Equatable, Sendable {
    public let text: String
    public let tone: NoticeTone

    public static func success(_ text: String) -> ActionNote { ActionNote(text: text, tone: .success) }
    public static func warning(_ text: String) -> ActionNote { ActionNote(text: text, tone: .warning) }
}

/// The bar's actual outcome state, shared by the command closures and tests. Keeping the
/// guarded note writes here lets tests drive completion without hosting SwiftUI.
@Observable
@MainActor
public final class ActionBarOutcome {
    public init() {}

    public var note: ActionNote?

    public func run(
        _ action: SessionAction,
        session: Session,
        command: SessionCommandState,
        operation: () async throws -> Void,
        failureCopy: (String) -> String,
        isCurrent: () -> Bool
    ) async {
        let ok = await command.run(
            operation, failureCopy: failureCopy, isCurrent: isCurrent)
        guard ok else { return }
        switch action {
        case .resume:
            note = .success(L.t("native_actions_resumed", session.name))
        case .toggleReady:
            note = .success(
                !session.readyToMerge ? L.t("native_actions_ready_on") : L.t("native_actions_ready_off"))
        case .regenerateRecap:
            note = .success(L.t("native_actions_recap_requested"))
        case .stop, .rename, .amend, .relaunch:
            assertionFailure("No inline outcome for \(action.id)")
        }
    }
}

@MainActor
public enum CurrentSessionSelection {
    public static func isCurrent(session: Session, store: SessionStore, app: AppModel) -> Bool {
        app.store === store && app.selectedSessionID == session.id
    }
}
