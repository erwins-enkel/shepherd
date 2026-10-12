import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// A task for a connected machine that is not settled (#2774, #2775), at the top of that machine's
/// group: waiting for the machine, blocked there, held there (busy), or its start status unknown.
/// The state word opens what it means and what happens next; a waiting task can run on another
/// machine that fits it now, and Cancel makes sure it never starts. Not a session, so not
/// selectable. The web's `RemoteDispatchRow.svelte`.
struct RemoteDispatchRow: View {
    let dispatch: RemoteDispatch
    let model: RemoteDispatchesModel
    @State private var explaining = false

    private var machine: String { dispatch.host.name }
    private var label: String { DispatchCopy.label(dispatch) }
    private var busy: Bool { model.busy.contains(dispatch.id) || !model.actionsAllowed }

    /// Amber for a standing condition Shepherd is resolving, warn when the machine needs fixing,
    /// slate for what the machine settles itself.
    private var tint: Color {
        switch DispatchCopy.tone(dispatch) {
        case .resolving: ShepherdPalette.amber
        case .blocked: ShepherdPalette.warn
        case .settling: ShepherdPalette.slate
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button { explaining = true } label: {
                    Text(verbatim: label.uppercased()).tracking(1)
                }
                .buttonStyle(.plain)
                .foregroundStyle(tint)
                .modifier(ShepherdMonoFont(label: true, weight: .semibold))
                .fixedSize()
                .help(DispatchCopy.explanation(dispatch).title)
                .accessibilityIdentifier("dispatch-state-\(dispatch.id)")
                .popover(isPresented: $explaining) {
                    RemoteExplanationView(explanation: DispatchCopy.explanation(dispatch))
                }
                if let detail = DispatchCopy.detail(dispatch) {
                    Text(verbatim: detail).lineLimit(1).truncationMode(.tail)
                        .foregroundStyle(ShepherdPalette.muted)
                }
            }
            Text(verbatim: dispatch.summary).lineLimit(2)
                .foregroundStyle(ShepherdPalette.ink)
            actions
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("remote_dispatch_row_aria", machine, label))
        .accessibilityIdentifier("dispatch-\(dispatch.id)")
        .contextMenu { actionButtons }
    }

    @ViewBuilder private var actions: some View {
        if dispatch.state.rawValue == "waiting" || DispatchCopy.isCancelable(dispatch) {
            HStack(spacing: 8) { actionButtons }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy)
        }
    }

    @ViewBuilder private var actionButtons: some View {
        if dispatch.state.rawValue == "waiting" {
            ForEach(dispatch.alternatives ?? [], id: \.instanceId) { host in
                Button(DispatchCopy.redirectLabel(host)) { Task { await model.redirect(dispatch, to: host) } }
                    .accessibilityLabel(L.t("remote_dispatch_redirect_aria", machine, host.name))
            }
        }
        if DispatchCopy.isCancelable(dispatch) {
            Button(L.t("common_cancel")) { Task { await model.cancel(dispatch) } }
                .accessibilityLabel(L.t("remote_dispatch_cancel_aria", machine))
                .accessibilityIdentifier("dispatch-cancel-\(dispatch.id)")
        }
    }
}
