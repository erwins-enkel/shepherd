import SwiftUI
import ShepherdKit

/// Compact read-only git rail. The optional presentation is also the render gate.
struct HerdRowGit: View {
    struct Presentation {
        let pr: SessionBadge?
        let number: String?
        let blockers: [SessionBadge]
    }

    let git: GitState?

    static func presentation(_ git: GitState?) -> Presentation? {
        guard let git else { return nil }
        var blockers: [SessionBadge] = []
        let key: StaticString?
        switch HerdClassifier.prReadinessBlock(git) {
        case .draft: key = "gitrail_merge_blocked_draft"
        case .behind: key = "gitrail_merge_blocked_behind"
        case .conflict: key = "gitrail_merge_blocked_conflict"
        case .blocked: key = "gitrail_merge_blocked_protected"
        case nil: key = nil
        }
        if let key { blockers.append(.init(id: "merge-blocker", text: L.t(key), tint: .orange)) }
        if git.state.known == .open, git.checks.known == .failure {
            blockers.append(.init(id: "checks-blocker", text: L.t("gitrail_merge_blocked_checks"), tint: .orange))
        }
        // Terminal labels omit the number in PrBadge; retain it on the git rail.
        let number = git.state.known == .merged || git.state.known == .closed
            ? git.number.map { L.t("prbadge_open", "\($0)") } : nil
        return Presentation(pr: SessionBadges.pr(git), number: number, blockers: blockers)
    }

    var body: some View {
        if let model = Self.presentation(git) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if let number = model.number {
                        Text(verbatim: number).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let pr = model.pr { SessionBadgeStack(badges: [pr]) }
                }
                ForEach(model.blockers) { blocker in
                    Text(verbatim: blocker.text)
                        .font(.caption2)
                        .foregroundStyle(blocker.tint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityIdentifier("herd-git-rail")
        }
    }
}

/// heartbeat.ts: 24 twenty-second cells over the last eight minutes, oldest first.
enum HerdHeartbeat {
    struct Cell: Identifiable {
        let id: Int
        var level = 0
        var error = false
        var newest = false
        var tint: Color { error ? .red : (level > 0 ? .orange : .secondary) }
        var label: String {
            if error { return L.t("heartbeat_legend_error_label") }
            return level > 0 ? L.t("heartbeat_legend_active_label") : L.t("heartbeat_legend_idle_label")
        }
    }

    static func cells(_ activity: SessionActivitySignal?, now: Int) -> [Cell] {
        var cells = (0..<24).map { Cell(id: $0) }
        let errors = Set(activity?.recentErrTs ?? [])
        var newest = 0
        var newestIndex: Int?
        for ts in activity?.recentTs ?? [] {
            guard ts > 0, ts <= now, now - ts < 480_000 else { continue }
            let index = 23 - (now - ts) / 20_000
            cells[index].level = min(4, cells[index].level + 1)
            cells[index].error = cells[index].error || errors.contains(ts)
            if ts > newest { newest = ts; newestIndex = index }
        }
        if let newestIndex { cells[newestIndex].newest = true }
        return cells
    }
}

struct HerdHeartbeatView: View {
    let activity: SessionActivitySignal
    let now: Int

    var body: some View {
        let cells = HerdHeartbeat.cells(activity, now: now)
        let stateLabel = cells.contains { $0.error } ? L.t("heartbeat_legend_error_label")
            : (cells.contains { $0.level > 0 } ? L.t("heartbeat_legend_active_label") : L.t("heartbeat_legend_idle_label"))
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(cells) { cell in
                // Error gets a notch/outline as well as red: colour is never the only cue.
                RoundedRectangle(cornerRadius: 1)
                    .fill(cell.tint.opacity(cell.level == 0 ? 0.15 : (cell.newest ? 1 : 0.65)))
                    .frame(width: 4, height: cell.error ? 4 : CGFloat(2 + cell.level * 2))
                    .overlay {
                        if cell.error { RoundedRectangle(cornerRadius: 1).stroke(cell.tint, lineWidth: 1) }
                    }
                    .accessibilityLabel(Text(verbatim: cell.label))
            }
        }
        .frame(height: 10, alignment: .bottom)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: L.t("heartbeat_pop_intro") + " · " + stateLabel))
        .help(L.t("heartbeat_pop_intro"))
        .accessibilityIdentifier("herd-heartbeat")
    }
}

/// Uses the same live extension as classification, with no per-row requests or subscriptions.
struct HerdRowSignals: View {
    @Environment(AppModel.self) private var app
    let session: Session
    let block: BlockReason?
    let showCli: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 20)) { timeline in
            let herd = app.extension(HerdSignals.self)
            let git = herd?.git[session.id]
            let verdict = herd?.verdicts[session.id]
            let reviewing = (herd?.isReviewing(session.id) ?? false) || (herd?.planReviewing(session) ?? false)
            let now = Int(timeline.date.timeIntervalSince1970 * 1_000)
            let stepper = HerdClassifier.deriveStage(session: session, git: git, verdict: verdict, reviewing: reviewing)
            let badges = SessionBadges.items(for: session, block: block, git: git,
                verdict: verdict, reviewing: reviewing, showCli: showCli, now: now)
            VStack(alignment: .leading, spacing: 3) {
                HerdRowGit(git: git)
                // The PR and its sub-markers are rendered once, on the inline rail above.
                SessionBadgeStack(badges: badges.filter { $0.id != "pr" })
                // The terminal PR state already appears on the rail; avoid a second chip.
                if stepper.terminal == nil { HerdStepperView(info: stepper) }
                if let activity = herd?.activity[session.id] { HerdHeartbeatView(activity: activity, now: now) }
            }
        }
    }
}
