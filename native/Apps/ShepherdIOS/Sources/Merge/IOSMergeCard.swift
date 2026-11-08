import SwiftUI
import UIKit
import ShepherdAppCore
import ShepherdKit

/// The merge card above the steer capsule (#3542), iOS's `viewport/PrActionRow.svelte`:
/// status, PR, prerequisites and one main action. Shown while the session's PR is open, or merged
/// and the session still stands. A PR that is not ready offers its next step (#3718).
struct IOSMergeCard: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    let git: GitState
    let verdict: ReviewVerdict?
    let reviewing: Bool
    let canMerge: Bool
    /// The herd's swept agent liveness; nil while unknown.
    var alive: Bool?
    var rendersStaticFixture = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                // Large text: everything stacks, nothing truncates.
                summary
                stepLockNote
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { moreMenu; mainAction }
                    VStack(alignment: .leading, spacing: 8) { moreMenu; mainAction }
                }
            } else {
                HStack(spacing: 8) {
                    summary
                    Spacer(minLength: 0)
                    moreMenu
                    mainAction
                }
                stepLockNote
            }
            // After the status, so VoiceOver reads the state first.
            IOSActionFeedback(error: state.error, note: state.outcome.note, busy: state.busy && !state.merging,
                rendersStaticFixture: rendersStaticFixture)
            if !state.allowsWrites {
                Text(L.t("native_ios_actions_read_only")).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(SessionListStyle.ink)
        .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { cardBackground }
        .padding(.horizontal, 10).padding(.top, 6)
        .tint(SessionListStyle.amber)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("prrow_aria", String(git.number ?? 0)))
        .accessibilityIdentifier("merge-card")
        .task(id: session.id) { await state.loadRepoAutopilot() }
    }

    private var kind: MergeRowRules.Kind { MergeRowRules.kind(git, merging: state.merging) }
    private var base: String { git.baseRefName ?? session.baseBranch }
    private var facts: [MergeRowRules.Fact] {
        MergeRowRules.facts(git, verdict: verdict, reviewing: reviewing, base: base)
    }
    private var step: MergeRowRules.NextStep {
        MergeRowRules.nextStep(kind, autopilot: state.autopilot, criticReviewing: reviewing,
            live: MergeRowRules.agentLive(session, alive: alive))
    }
    /// A next step owns the main slot; otherwise it asks for Ready first: a session not handed
    /// back cannot merge yet.
    private var offersReady: Bool {
        step.action == .merge && !session.readyToMerge && state.actions.contains(.toggleReady)
    }
    /// Why Merge is locked, or nil when it is free. Read by VoiceOver as the button's hint.
    private var lockReason: String? {
        if let blocked = MergeRowRules.blockedText(kind) { return blocked }
        if !state.allowsWrites { return L.t("native_ios_actions_read_only") }
        if reviewing { return L.t("prrow_fact_critic_reviewing") }
        return nil
    }
    private var mergeFree: Bool {
        lockReason == nil && canMerge && !state.busy && !state.mergeModel.busy
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label {
                Text(verbatim: MergeRowRules.label(kind, base: base).uppercased())
            } icon: { Image(systemName: glyph).accessibilityHidden(true) }
                .sessionFont(label: true, weight: .semibold).foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("merge-card-status")
            Text(verbatim: "#\(git.number ?? 0) \(git.title ?? session.name)")
                .sessionFont().foregroundStyle(SessionListStyle.bright)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
            Text(verbatim: facts.map { "\($0.glyph) \($0.text)" }.joined(separator: " · "))
                .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(facts.map(\.text).joined(separator: ", "))
                .accessibilityIdentifier("merge-card-facts")
        }
    }

    /// A locked step names its reason in the card, not only to VoiceOver.
    @ViewBuilder private var stepLockNote: some View {
        if step.mode == .locked, let reason = step.reason {
            Text(verbatim: reason).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("merge-card-step-reason")
        }
    }

    @ViewBuilder private var mainAction: some View {
        if step.action == .decommission {
            Button { state.presentDecommission() } label: {
                Label(L.t("gitrail_decommission_action"), systemImage: "archivebox")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle(minHeight: 48))
            .disabled(!state.canDecommission || state.busy)
            .accessibilityHint(L.t("prrow_tip_decommission"))
            .accessibilityIdentifier("action-decommission")
        } else if step.mode == .passive {
            Label(step.reason ?? "", systemImage: "steeringwheel")
                .sessionFont(label: true, weight: .semibold).foregroundStyle(SessionListStyle.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 48)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(step.reason ?? "")
                .accessibilityHint(L.t("prrow_passive_tip_body"))
                .accessibilityAddTraits(.isStaticText)
                .accessibilityIdentifier("merge-card-passive")
        } else if step.action != .merge {
            Button { sendStep() } label: {
                Label(state.stepSent ? L.t("prrow_sent") : stepTitle,
                    systemImage: state.stepSent ? "checkmark" : (step.action == .fixCI ? "wrench.and.screwdriver" : "arrow.triangle.branch"))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle(minHeight: 48))
            .disabled(step.mode == .locked || state.stepSent || state.busy || !state.allowsWrites)
            .accessibilityHint(step.reason ?? L.t(step.action == .fixCI ? "prrow_tip_fix_ci" : "prrow_tip_rebase"))
            .accessibilityIdentifier("action-step-\(step.action.rawValue)")
        } else if offersReady {
            Button { Task { await state.execute(.toggleReady) } } label: {
                Label(IOSSessionActionState.label(.toggleReady, session: session), systemImage: SessionAction.toggleReady.systemImage)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle(minHeight: 48))
            .disabled(state.busy || !state.allowsWrites)
            .accessibilityIdentifier("action-toggleReady")
        } else if IOSMergeConfirmationFacts.isTakeover(git) && kind != .merging {
            // Someone else is responsible: never in passing, the sheet names who.
            Button(action: state.prepareMerge) {
                Label(L.t("prbadge_merge"), systemImage: "arrow.triangle.merge")
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(IOSActionButtonStyle(minHeight: 48))
            .disabled(!mergeFree)
            .accessibilityHint(lockReason ?? L.t("native_ios_merge_opens_confirmation"))
            .accessibilityIdentifier("action-merge")
        } else {
            IOSMergeHoldButton(title: L.t("prbadge_merge"), enabled: mergeFree && state.canHoldMerge(git),
                merging: kind == .merging, hint: lockReason ?? L.t("native_ios_merge_hold_hint"),
                merge: state.holdMerge, confirm: state.prepareMerge)
        }
    }

    private var stepTitle: String { L.t(step.action == .fixCI ? "prrow_fix_ci" : "prrow_rebase") }

    private func sendStep() {
        let action = step.action, git = git, base = base
        Task {
            if await state.sendStep(action, git: git, base: base) {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
        }
    }

    @ViewBuilder private var moreMenu: some View {
        if rendersStaticFixture { moreLabel }
        else {
            Menu {
                if kind != .merged && MergeRowRules.checksCleared(git) && !reviewing {
                    Button(L.t(verdict == nil ? "gitrail_review" : "gitrail_rereview"), systemImage: "arrow.clockwise") {
                        Task { await state.requestReview() }
                    }.disabled(state.busy || !state.allowsWrites)
                        .accessibilityIdentifier("merge-card-review")
                }
                if (session.readyToMerge || step.action != .merge) && state.actions.contains(.toggleReady) {
                    Button(IOSSessionActionState.label(.toggleReady, session: session), systemImage: SessionAction.toggleReady.systemImage) {
                        Task { await state.execute(.toggleReady) }
                    }.disabled(state.busy || !state.allowsWrites)
                }
                if kind == .ciFailed, let logs = MergeRowRules.logsURL(git) {
                    Button(L.t("prrow_logs_link"), systemImage: "doc.text.magnifyingglass") { openURL(logs) }
                        .accessibilityLabel(L.t("prrow_logs_aria"))
                        .accessibilityIdentifier("merge-card-logs")
                }
                if let url = git.url.flatMap(URL.init(string:)), url.scheme == "https" || url.scheme == "http" {
                    Button(L.t("prrow_pr_link"), systemImage: "arrow.up.right.square") { openURL(url) }
                }
                if !offersReady && kind == .ready && canMerge {
                    Divider()
                    Button(L.t("native_ios_merge_with_options"), systemImage: "slider.horizontal.3", action: state.prepareMerge)
                        .disabled(!mergeFree)
                        .accessibilityIdentifier("merge-card-options")
                }
            } label: { moreLabel }
                .accessibilityLabel(L.t("prrow_more_aria"))
                .accessibilityIdentifier("merge-card-menu")
        }
    }

    private var moreLabel: some View {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
            .foregroundStyle(SessionListStyle.ink)
    }

    private var glyph: String {
        switch kind {
        case .ready: "checkmark.circle"
        case .merging: "arrow.triangle.merge"
        case .ciRunning: "clock"
        case .ciFailed: "xmark.circle"
        case .conflict: "exclamationmark.triangle"
        case .behind: "arrow.down.circle"
        case .draft: "pencil.circle"
        case .protected: "lock"
        case .merged: "circle"
        }
    }

    private var tint: Color {
        switch kind {
        case .ready: SessionListStyle.green
        case .merging, .ciRunning: SessionListStyle.amber
        case .ciFailed: SessionListStyle.red
        default: SessionListStyle.ink
        }
    }

    /// The capsule's shape language: panel, 1 pt line, shadow, glass on iOS 26. Ready tints green.
    @ViewBuilder private var cardBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 22)
        if #available(iOS 26.0, *), !rendersStaticFixture {
            shape.fill(SessionListStyle.panel.opacity(0.7)).glassEffect(.regular, in: shape)
        } else { shape.fill(SessionListStyle.panel) }
        if kind == .ready { shape.fill(SessionListStyle.green.opacity(0.07)) }
        shape.stroke(kind == .ready ? SessionListStyle.green.opacity(0.45) : SessionListStyle.line)
            .shadow(color: SessionListStyle.background.opacity(0.45), radius: 8, y: 4)
    }
}

/// "PR mergen" as a hold (#3542): fills amber from the left and merges at 100 %. Releasing
/// early cancels. VoiceOver and Switch Control cannot hold, so their activation and the named
/// action open the confirmation sheet instead.
struct IOSMergeHoldButton: View {
    let title: String
    let enabled: Bool
    let merging: Bool
    let hint: String
    let merge: () -> Void
    let confirm: () -> Void
    var duration = 1.2
    @State private var progress: Double = 0
    @State private var ticks: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.merge").accessibilityHidden(true)
            Text(verbatim: label).fixedSize(horizontal: false, vertical: true)
        }
        .sessionFont(label: true, weight: .semibold)
        .foregroundStyle(enabled || merging ? SessionListStyle.amber : SessionListStyle.muted)
        .padding(.horizontal, 10).padding(.vertical, 8).frame(minHeight: 48)
        .background(alignment: .leading) {
            GeometryReader { geometry in
                SessionListStyle.amber.opacity(0.3).frame(width: geometry.size.width * progress)
            }
        }
        .background(SessionListStyle.background)
        .clipShape(RoundedRectangle(cornerRadius: 2))
        .overlay {
            RoundedRectangle(cornerRadius: 2)
                .stroke(enabled || merging ? SessionListStyle.amber : SessionListStyle.brightLine, lineWidth: 1)
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: duration, maximumDistance: 40) {
            complete()
        } onPressingChanged: { pressing in
            pressing ? start() : reset()
        }
        .disabled(!enabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(merging ? L.t("prrow_merging") : title)
        .accessibilityValue(progress > 0 ? percent : "")
        .accessibilityHint(hint)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if enabled { confirm() } }
        .accessibilityAction(named: Text(verbatim: title)) { if enabled { confirm() } }
        .accessibilityIdentifier("action-merge")
    }

    /// Reduced motion shows the fill as a percentage instead of an animation.
    private var label: String {
        if merging { return L.t("prrow_merging") }
        return reduceMotion && progress > 0 ? "\(title) \(percent)" : title
    }
    private var percent: String { progress.formatted(.percent.precision(.fractionLength(0))) }

    private func start() {
        ticks?.cancel()
        guard enabled else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if !reduceMotion { withAnimation(.linear(duration: duration)) { progress = 1 } }
        let began = Date(), duration = duration, stepped = reduceMotion
        ticks = Task { @MainActor in
            let haptic = UISelectionFeedbackGenerator()
            var quarter = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
                let fraction = min(1, Date().timeIntervalSince(began) / duration)
                if stepped { progress = fraction }
                // A light tick per quarter while it fills.
                if Int(fraction * 4) > quarter { quarter = Int(fraction * 4); haptic.selectionChanged() }
                if fraction >= 1 { return }
            }
        }
    }

    private func complete() {
        reset()
        guard enabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        merge()
    }

    private func reset() {
        ticks?.cancel(); ticks = nil
        if reduceMotion { progress = 0 } else { withAnimation(.easeOut(duration: 0.2)) { progress = 0 } }
    }
}
