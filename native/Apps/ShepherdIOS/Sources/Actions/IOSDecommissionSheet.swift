import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Decommission with the web's decisions: which leftovers to terminate, then what happens to an
/// open PR. The sheet is the confirmation; there is no undo window.
struct IOSDecommissionSheet: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    var body: some View {
        NavigationStack {
            ScrollView { IOSDecommissionContent(session: session, state: state).padding(16) }
                .background(SessionListStyle.background)
                .navigationTitle(L.t("cardmenu_decommission")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_cancel"), action: state.dismiss).disabled(state.busy)
                        .accessibilityIdentifier("decommission-cancel")
                } }
        }
        .tint(SessionListStyle.amber).preferredColorScheme(.dark)
        .interactiveDismissDisabled(state.busy)
    }
}

/// UIKit-backed Toggle does not draw into ImageRenderer; fixtures render the checkbox as a Label.
struct IOSDecommissionContent: View {
    let session: Session
    @Bindable var state: IOSSessionActionState
    var rendersStaticFixture = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: session.name).foregroundStyle(SessionListStyle.muted)
            Text(L.t("native_archive_confirm_body")).fixedSize(horizontal: false, vertical: true)
            if state.decommissionDraft.listing?.probesUnavailable == true {
                Label(L.t("native_compose_probes_unavailable"), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(SessionListStyle.amber).fixedSize(horizontal: false, vertical: true)
            }
            leftovers
            IOSActionFeedback(error: state.error, busy: state.busy || !state.decommissionDraft.loaded,
                rendersStaticFixture: rendersStaticFixture)
            if state.decommissionDraft.loaded { choices }
        }
        .disabled(state.busy).sessionFont().foregroundStyle(SessionListStyle.ink)
    }

    @ViewBuilder private var leftovers: some View {
        if let items = state.decommissionDraft.listing?.leftovers, !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle(L.t("leftover_title"))
                Text(L.t("leftover_desc")).fixedSize(horizontal: false, vertical: true)
                ForEach(items, id: \.key) { item in
                    if rendersStaticFixture {
                        Label { leftoverLabel(item) } icon: {
                            Image(systemName: state.reap.contains(item.key) ? "checkmark.square" : "square")
                        }
                    } else {
                        Toggle(isOn: Binding(get: { state.reap.contains(item.key) }, set: { on in
                            if on { state.reap.insert(item.key) } else { state.reap.remove(item.key) }
                        })) { leftoverLabel(item) }
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("decommission-leftover-\(item.key)")
                    }
                }
            }
        }
    }

    private func leftoverLabel(_ item: Components.Schemas.ComposeLeftover) -> some View {
        HStack {
            Text(verbatim: item.name).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let port = item.port { Text(L.t("leftover_port", String(port))).foregroundStyle(SessionListStyle.muted) }
        }
    }

    @ViewBuilder private var choices: some View {
        if let pr = state.decommissionOpenPR {
            VStack(alignment: .leading, spacing: 10) {
                sectionTitle(L.t("decommission_pr_title", pr.number.map { String($0) } ?? "?"))
                Text(L.t("decommission_pr_desc", session.name)).fixedSize(horizontal: false, vertical: true)
                if state.decommissionChoices.contains(.merge) { IOSMergeResponsibilityNotice(git: pr) }
                ForEach(state.decommissionChoices, id: \.self) { choice in button(choice, pr: pr) }
            }
        } else {
            button(.keep, pr: nil)
        }
    }

    private func button(_ choice: IOSSessionActionState.DecommissionChoice, pr: GitState?) -> some View {
        Button { Task { await state.decommission(choice) } } label: {
            Text(verbatim: Self.title(choice, pr: pr))
                .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(IOSActionButtonStyle(tint: Self.tint(choice, pr: pr)))
        .disabled(!state.canConfirmDecommission(choice))
        .accessibilityIdentifier("decommission-\(choice)")
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(verbatim: title.uppercased()).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            .accessibilityAddTraits(.isHeader)
    }

    /// Web `isMergeTakeover`: the gate names someone else, so merging is taking it over.
    static func isTakeover(_ pr: GitState) -> Bool {
        pr.mergeGate?.handoff != nil || pr.mergeGate?.reviewBlockBy != nil
    }

    /// Without an open PR the only choice is the plain decommission.
    static func title(_ choice: IOSSessionActionState.DecommissionChoice, pr: GitState?) -> String {
        guard let pr else { return L.t("cardmenu_decommission") }
        switch choice {
        case .keep: return L.t("decommission_pr_keep")
        case .merge: return L.t(isTakeover(pr) ? "decommission_pr_merge_takeover" : "decommission_pr_merge")
        case .close: return L.t("decommission_pr_close")
        }
    }

    private static func tint(_ choice: IOSSessionActionState.DecommissionChoice, pr: GitState?) -> Color {
        guard let pr else { return SessionListStyle.red }
        switch choice {
        case .keep: return SessionListStyle.amber
        case .merge: return isTakeover(pr) ? SessionListStyle.amber : SessionListStyle.ink
        case .close: return SessionListStyle.red
        }
    }
}
