import Foundation
import ShepherdAppCore

/// Read the same rendered status and terminal lifecycle labels as SessionCardView.
@MainActor
enum IOSCommandBarContext {
    static func facts(_ snapshot: IOSMergedSessionPresentation.Snapshot, owners: [UUID: AppModel],
                      fallback: AppModel, sidebar: SidebarModel) -> [IOSSessionIdentity: IOSCommandBarPresentation.SessionFacts] {
        var result: [IOSSessionIdentity: IOSCommandBarPresentation.SessionFacts] = [:]
        for row in IOSCommandBarPresentation.sessions(snapshot) {
            let owner = owners[row.profile.id] ?? fallback
            let model = owner.extension(SidebarModel.self) ?? sidebar
            let displayed = model.rendered(row.session)
            let herd = owner.extension(HerdSignals.self)
            let progress = HerdStepper(info: HerdClassifier.deriveStage(session: row.session,
                git: herd?.git[row.session.id], verdict: herd?.verdicts[row.session.id],
                reviewing: herd?.isReviewing(row.session.id) ?? false))
            let status = progress.terminal != nil ? progress.accessibilityLabel
                : displayed.readyToMerge ? L.t("status_ready_to_merge") : SessionStatusStyle.label(displayed.status)
            result[row.id] = .init(status: status, needsYou: displayed.status.known == .blocked
                || (row.session.autopilotPaused && displayed.status.known != .running))
        }
        return result
    }
}
