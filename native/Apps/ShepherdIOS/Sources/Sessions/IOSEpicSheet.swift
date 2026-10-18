import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Loads independently of the herd's summary and shares write ownership with its header.
struct IOSEpicSheet: View {
    let control: IOSEpicControl
    let now: Int
    let session: (EpicChild) -> (() -> Void)?
    let created: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var child: EpicChildSelection?
    @State private var settings = false
    @State private var stopping = false

    var body: some View {
        NavigationStack {
            ScrollView {
                if !control.current {
                    Text(verbatim: L.t("native_error_offline")).sessionFont().padding()
                } else if let digest = control.digest {
                    IOSEpicDetailContent(repo: control.group.repoName, digest: digest, now: now,
                        busy: control.busy, writable: control.writable, error: control.error,
                        update: { patch in Task { await control.update(patch) } },
                        approve: { Task { await control.approve() } },
                        settings: { settings = true }, stop: { stopping = true }, child: { value in
                            if value.isInFlight, let open = session(value) { open(); dismiss() }
                            else { child = .init(number: value.number) }
                        })
                } else {
                    VStack(spacing: 16) {
                        if let error = control.error {
                            Text(verbatim: error).foregroundStyle(SessionListStyle.red)
                            Button(L.t("common_retry")) { Task { await control.load() } }.disabled(control.busy)
                        } else { ProgressView(L.t("common_loading")) }
                    }.sessionFont().frame(maxWidth: .infinity, minHeight: 200).padding()
                }
            }.background(SessionListStyle.background)
                .navigationTitle(Text(verbatim: "EPIC #\(control.group.parentNumber)"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(L.t("common_close")) { dismiss() } }
                    if let epic = control.digest?.epic, let url = IOSEpicPolicy.parentURL(epic) {
                        ToolbarItem(placement: .topBarTrailing) {
                            Link(destination: url) { Image(systemName: "arrow.up.right.square").frame(minWidth: 44, minHeight: 44) }
                                .accessibilityLabel(L.t("native_ios_epic_parent_link", String(epic.parentIssueNumber)))
                        }
                    }
                }
        }
        .presentationDetents([.large]).preferredColorScheme(.dark).tint(SessionListStyle.amber)
        .task { await control.load() }
        .task { await control.observe() }
        .sheet(isPresented: $settings) { if let epic = control.digest?.epic { IOSEpicSettingsSheet(control: control, epic: epic) } }
        .sheet(item: $child) { selection in
            if let digest = control.digest, let value = digest.epic.children.first(where: { $0.number == selection.number }) {
                IOSEpicChildSheet(control: control, digest: digest, child: value, session: session(value), created: created)
            }
        }
        .confirmationDialog(L.t("native_ios_epic_stop"), isPresented: $stopping, titleVisibility: .visible) {
            Button(L.t("native_ios_epic_stop"), role: .destructive) { Task { await control.update(.init(status: .idle)) } }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: { Text(verbatim: L.t("native_ios_epic_stop_message")) }
        .modifier(IOSEpicConfirmation(control: control, enabled: !settings && child == nil))
        .onDisappear { control.cancelStart() }
        .accessibilityIdentifier("epic-sheet-\(control.group.parentNumber)")
    }
}
private struct EpicChildSelection: Identifiable { let number: Int; var id: Int { number } }

/// Production layout also rendered by the fixture tests (no UIKit-backed scroll containers).
struct IOSEpicDetailContent: View {
    let repo: String
    let digest: EpicDigest
    let now: Int
    var busy = false
    var writable = true
    var error: String?
    var update: (Components.Schemas.EpicRunPatch) -> Void = { _ in }
    var approve: () -> Void = {}
    var settings: () -> Void = {}
    var stop: () -> Void = {}
    var child: (EpicChild) -> Void = { _ in }
    private var epic: Epic { digest.epic }
    private var ordered: [EpicChild] { digest.flow.stages.flatMap(\.children) }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 10) {
                Text(verbatim: repo).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                Text(verbatim: EpicText.displayTitle(epic.parentTitle)).sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
                IOSEpicMeter(tones: digest.meter, height: 5, spacing: 3)
                SessionWrappingLayout(spacing: 10) {
                    count(digest.merged, "epicflow_legend_merged")
                    Text(verbatim: L.t("native_ios_epic_in_flight", String(digest.inFlight))).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                    count(ordered.filter(\.isReady).count, "epicflow_legend_ready")
                    count(ordered.filter { !$0.isMerged && !$0.isReady && !$0.isInFlight }.count, "epicflow_legend_waiting")
                }
            }
            runCard
            children("native_ios_epic_now", ordered.filter(\.isInFlight))
            children("native_ios_epic_next", ordered.filter(\.isReady))
            children("native_ios_epic_waiting", ordered.filter { !$0.isMerged && !$0.isReady && !$0.isInFlight })
            children("native_ios_epic_done", ordered.filter(\.isMerged))
            if let url = IOSEpicPolicy.parentURL(epic) {
                Link(destination: url) {
                    Label(L.t("native_ios_epic_parent_link", String(epic.parentIssueNumber)), systemImage: "arrow.up.right.square")
                        .sessionFont(label: true).frame(maxWidth: .infinity, minHeight: 44)
                }.foregroundStyle(SessionListStyle.blue)
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func count(_ number: Int, _ key: StaticString) -> some View {
        Text(verbatim: "\(number) " + L.t(key)).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
    }
    private var runCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                heading("epic_run_label")
                Spacer()
                IOSEpicRunChip(text: IOSEpicCopy.runChip(epic) ?? L.t("native_ios_epic_idle")).sessionFont(label: true)
                if busy { ProgressView().accessibilityLabel(L.t("common_loading")) }
            }
            if let clock = IOSEpicCopy.clock(epic, now: now) { Text(verbatim: clock).sessionFont(label: true) }
            if let forecast = IOSEpicCopy.forecast(epic) { Text(verbatim: forecast).sessionFont(label: true) }
            if writable {
                IOSEpicModePicker(mode: Binding(get: { epic.run.mode.iosValue == "attended" ? .attended : .auto },
                    set: { update(.init(mode: $0)) })).disabled(busy)
                if IOSEpicPolicy.actions(epic).contains(.approve) {
                    Text(verbatim: L.t("native_ios_epic_approval_hint")).sessionFont(label: true)
                    IOSEpicActionButton(title: L.t("native_ios_epic_approve"), icon: "checkmark", action: approve).disabled(busy)
                }
                HStack(spacing: 10) {
                    if epic.run.status.rawValue == "idle" {
                        IOSEpicActionButton(title: L.t("epic_start"), icon: "play", action: settings)
                    } else if ["running", "paused"].contains(epic.run.status.rawValue) {
                        let paused = epic.run.status.rawValue == "paused"
                        IOSEpicActionButton(title: L.t(paused ? "native_ios_epic_resume" : "epic_pause"), icon: paused ? "play" : "pause") {
                            update(.init(status: paused ? .running : .paused))
                        }
                        IOSEpicActionButton(title: L.t("native_ios_epic_stop"), icon: "stop", tint: SessionListStyle.muted, action: stop)
                    }
                }.disabled(busy)
                Button(action: settings) {
                    HStack(alignment: .top, spacing: 10) {
                        Text(verbatim: L.t("native_ios_epic_agent")).foregroundStyle(SessionListStyle.muted)
                        Spacer(minLength: 0)
                        Text(verbatim: [epic.run.agentProvider.map { L.t($0 == .claude ? "agent_provider_claude" : "agent_provider_codex") } ?? L.t("epic_provider_inherit"), epic.run.model ?? L.t("newtask_model_default"), IOSEpicSettingsContent.effort(epic.run.effort ?? "default")].joined(separator: " · "))
                            .multilineTextAlignment(.trailing)
                        Image(systemName: "chevron.right").foregroundStyle(SessionListStyle.muted)
                    }.sessionFont(label: true).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(busy)
            }
            if let error { Text(verbatim: error).sessionFont(label: true).foregroundStyle(SessionListStyle.red) }
        }.foregroundStyle(SessionListStyle.ink).padding(12).background(SessionListStyle.panel)
            .overlay { Rectangle().stroke(SessionListStyle.line, lineWidth: 1) }
    }
    private func heading(_ key: StaticString) -> some View {
        Text(verbatim: L.t(key).uppercased()).sessionFont(label: true, weight: .medium)
            .tracking(0.8).foregroundStyle(SessionListStyle.muted).accessibilityAddTraits(.isHeader)
    }
    @ViewBuilder private func children(_ key: StaticString, _ values: [EpicChild]) -> some View {
        if !values.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                heading(key)
                ForEach(values, id: \.number) { value in
                    Button { child(value) } label: {
                        HStack(alignment: .top, spacing: 9) {
                            IOSEpicStateDot(tone: IOSEpicStateDot.tone(value)).padding(.top, 4)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(verbatim: "#\(value.number)  " + EpicText.stepTitle(value.title, parent: epic.parentIssueNumber))
                                    .foregroundStyle(value.isMerged ? SessionListStyle.muted : SessionListStyle.bright)
                                Text(verbatim: IOSEpicCopy.state(value)).foregroundStyle(SessionListStyle.muted)
                                if !value.isMerged, !value.isReady, !value.isInFlight, !value.blockedBy.isEmpty {
                                    Text(verbatim: L.t("native_ios_epic_waits_on", EpicText.numbers(value.blockedBy)))
                                        .foregroundStyle(SessionListStyle.muted)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").foregroundStyle(SessionListStyle.muted)
                        }.sessionFont(label: true).padding(10).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                            .background(SessionListStyle.panel).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("epic-child-\(value.number)")
                }
            }
        }
    }
}
