import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// The epic sheet behind the EPIC badge: progress, clock and forecast, what runs now, and the
/// whole flow by stage. It only shows; controlling an epic stays in the browser.
struct IOSEpicSheet: View {
    let group: IOSMergedSessionPresentation.EpicGroup
    let digest: EpicDigest
    let now: Int
    /// The action that opens a child's session, or nil when this group lists none for it.
    let session: (EpicChild) -> (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private var parent: Int { digest.epic.parentIssueNumber }
    private var running: [EpicChild] {
        digest.epic.children.filter(\.isInFlight).sorted { $0.order < $1.order }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    head
                    progress
                    if !running.isEmpty { nowSection }
                    flowSection
                    footer
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(SessionListStyle.panel)
            .navigationTitle(Text(verbatim: "EPIC #\(parent)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close")) { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("epic-sheet-\(group.parentNumber)")
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: group.repoName).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            Text(verbatim: EpicText.displayTitle(digest.epic.parentTitle)).sessionFont(weight: .semibold)
                .foregroundStyle(SessionListStyle.bright).fixedSize(horizontal: false, vertical: true)
            if let chip = IOSEpicCopy.runChip(digest.epic) { IOSEpicRunChip(text: chip).sessionFont(label: true) }
        }
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 7) {
            IOSEpicMeter(tones: digest.meter, height: 4, spacing: 3)
            Text(verbatim: [L.t("epicflow_merged", String(digest.merged), String(digest.total)),
                            digest.inFlight > 0 ? L.t("native_ios_epic_in_flight", String(digest.inFlight)) : nil]
                .compactMap { $0 }.joined(separator: " · "))
                .foregroundStyle(SessionListStyle.ink)
            let clock = [IOSEpicCopy.clock(digest.epic, now: now), IOSEpicCopy.forecast(digest.epic)].compactMap { $0 }
            if !clock.isEmpty {
                Text(verbatim: clock.joined(separator: " · ")).foregroundStyle(SessionListStyle.muted)
            }
        }
        .sessionFont(label: true)
    }

    private var nowSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel(L.t("native_ios_epic_now"))
            ForEach(running, id: \.number) { child in
                childButton(child) { nowRow(child) }
            }
        }
    }

    private func nowRow(_ child: EpicChild) -> some View {
        HStack(spacing: 10) {
            IOSEpicStateDot(tone: .active)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(verbatim: "#\(child.number)").foregroundStyle(SessionListStyle.bright)
                    Text(verbatim: EpicText.stepTitle(child.title, parent: parent)).lineLimit(1)
                }
                HStack(spacing: 6) {
                    if let pr = child.prNumber {
                        Text(verbatim: "PR #\(pr)").padding(.horizontal, 5).padding(.vertical, 1)
                            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.brightLine, lineWidth: 1) }
                    }
                    Text(verbatim: stateWord(child)).foregroundStyle(SessionListStyle.amber)
                }
                .foregroundStyle(SessionListStyle.muted)
            }
            Spacer(minLength: 0)
            if session(child) != nil {
                Image(systemName: "chevron.right").foregroundStyle(SessionListStyle.muted).accessibilityHidden(true)
            }
        }
        .sessionFont(label: true)
        .padding(10)
        .frame(minHeight: 52)
        .background(SessionListStyle.background)
        .overlay { Rectangle().stroke(SessionListStyle.line, lineWidth: 1) }
    }

    private var flowSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionLabel(L.t("epicflow_title"))
            ForEach(digest.flow.stages, id: \.index) { stage in
                HStack(spacing: 8) {
                    Text(verbatim: stageTitle(stage).uppercased()).tracking(0.8)
                    Spacer(minLength: 6)
                    let after = Set(stage.children.flatMap { digest.flow.blockers[$0.number] ?? [] }).sorted()
                    if !after.isEmpty { Text(verbatim: L.t("native_ios_epic_after", EpicText.numbers(after))) }
                }
                .sessionFont(label: true, weight: .medium)
                .foregroundStyle(SessionListStyle.muted)
                .padding(.top, 6)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(stage.children, id: \.number) { child in
                        childButton(child) { nodeRow(child) }
                    }
                }
                .padding(.leading, 18)
                .overlay(alignment: .leading) {
                    if stage.index < digest.flow.stages.count {
                        Rectangle().fill(SessionListStyle.brightLine).frame(width: 1).padding(.leading, 3)
                    }
                }
            }
            SessionWrappingLayout(spacing: 12) {
                legendItem(.active, "epicflow_legend_active")
                legendItem(.ready, "epicflow_legend_ready")
                legendItem(.waiting, "epicflow_legend_waiting")
                legendItem(.merged, "epicflow_legend_merged")
            }
            .padding(.top, 6)
            if let stage = digest.flow.firstParallelStage {
                Text(verbatim: L.t("native_ios_epic_slots_hint", String(stage)))
                    .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            }
        }
    }

    private func nodeRow(_ child: EpicChild) -> some View {
        HStack(spacing: 9) {
            IOSEpicStateDot(tone: IOSEpicStateDot.tone(child))
            Text(verbatim: "#\(child.number)").foregroundStyle(SessionListStyle.bright)
            Text(verbatim: EpicText.stepTitle(child.title, parent: parent))
                .foregroundStyle(child.isMerged ? SessionListStyle.muted : SessionListStyle.ink)
                .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            if child.isInFlight {
                Text(verbatim: stateWord(child)).foregroundStyle(SessionListStyle.amber).fixedSize()
            } else if !child.isMerged, let unlocks = digest.chain(child.number)?.unlocks.count, unlocks > 0 {
                Text(verbatim: L.t("native_ios_epic_frees", String(unlocks))).foregroundStyle(SessionListStyle.muted).fixedSize()
            }
        }
        .sessionFont(label: true)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(Text(verbatim: IOSEpicCopy.state(child)))
    }

    private var footer: some View {
        Button { openURL(group.profile.baseURL) } label: {
            Label(L.t("native_ios_epic_open_web"), systemImage: "arrow.up.right.square")
                .sessionFont(label: true)
                .frame(maxWidth: .infinity, minHeight: 44)
                .overlay { Rectangle().stroke(SessionListStyle.brightLine, lineWidth: 1) }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(SessionListStyle.ink)
        .accessibilityIdentifier("epic-open-web")
    }

    @ViewBuilder
    private func childButton<Content: View>(_ child: EpicChild, @ViewBuilder label: () -> Content) -> some View {
        if let action = session(child) {
            Button { action(); dismiss() } label: { label() }.buttonStyle(.plain)
        } else {
            label()
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(verbatim: text.uppercased()).sessionFont(label: true, weight: .medium).tracking(0.8)
            .foregroundStyle(SessionListStyle.muted).accessibilityAddTraits(.isHeader)
    }

    private func legendItem(_ tone: IOSEpicDotTone, _ key: StaticString) -> some View {
        HStack(spacing: 5) { IOSEpicStateDot(tone: tone); Text(verbatim: L.t(key)) }
            .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
    }

    private func stageTitle(_ stage: EpicFlow.Stage) -> String {
        if stage.index == 1 { return L.t("epicflow_stage_first") }
        return stage.parallel ? L.t("epicflow_stage_parallel", String(stage.index)) : String(stage.index)
    }

    private func stateWord(_ child: EpicChild) -> String {
        L.t(child.state.rawValue == "in-review" ? "epic_state_in_review" : "epic_state_running")
    }
}
