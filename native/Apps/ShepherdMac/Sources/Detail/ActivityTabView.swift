import SwiftUI
import ShepherdKit

/// The agent's recent tool use, newest first — the native reading of ActivityFeed.svelte.
///
/// `.task(id:)` loads once per session and doubles as the late-registration reconcile: the model
/// does not replay history for a tab that mounts after some activity already happened (it only
/// reacts to *future* `session:activity` pushes — see `DetailModel.subscribe(_:)`), so this is
/// the one place that asks for the current state rather than assuming the model already has it.
/// After that, `DetailModel.subscribe(_:)` reloads on every `session:activity` push, whether or
/// not this tab is the one visible — coalesced there, not here. Keying on the session id still
/// matters: SwiftUI cancels the load when the operator selects another row, and the model drops
/// whatever read was still in flight rather than caching it under the session that asked.
struct ActivityTabView: View {
    let session: Session
    let model: DetailModel

    private var state: Loaded<[ActivityEntry]> { model.activity[session.id] ?? .loading }
    /// Newest first: the server sends oldest-first and the operator reads the latest line.
    private var entries: [ActivityEntry] { (state.value ?? []).reversed() }

    var body: some View {
        DetailStateView(state: phase, retry: reload) {
            List(Array(entries.enumerated()), id: \.offset) { _, entry in row(entry) }
                .listStyle(.inset)
                .accessibilityIdentifier("detail-activity-list")
        }
        .accessibilityIdentifier("detail-tab-activity")
        .toolbar {
            ToolbarItem {
                Button(L.t("native_detail_refresh"), systemImage: "arrow.clockwise", action: reload)
                    .labelStyle(.iconOnly)
                    .disabled(state.isLoading || model.isRefreshing(.activity, session: session.id))
            }
        }
        .task(id: session.id) { await model.poll(.activity, session: session.id) }
    }

    private var phase: DetailStatePhase {
        if let failure = state.failure { return .failed(failure) }
        if state.value == nil { return .loading }
        return entries.isEmpty ? .empty(L.t("activity_empty")) : .content
    }

    private func row(_ entry: ActivityEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: Self.clock(entry.ts))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Text(verbatim: entry.tool)
                .font(.caption.monospaced().weight(.semibold))
                .frame(width: 88, alignment: .leading)
            Text(verbatim: entry.summary)
                .font(.callout)
                // An open enum: only the error we know about earns the red tint.
                .foregroundStyle(entry.status.known == .error ? Color.red : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .opacity(entry.status.known == .pending ? 0.6 : 1)
    }

    private static func clock(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .omitted, time: .standard)
    }

    private func reload() { Task { await model.load(.activity, session: session.id) } }
}

#if DEBUG
#Preview("Activity — with entries") {
    var loaders = DetailModel.Loaders.stubbed()
    loaders.activity = { _ in
        [
            ActivityEntry(ts: 1_700_000_000_000, tool: "Read", summary: "read toolbar.ts",
                status: .init(known: .ok)),
            ActivityEntry(ts: 1_700_000_005_000, tool: "Edit", summary: "wired the click handler",
                status: .init(known: .ok)),
            ActivityEntry(ts: 1_700_000_010_000, tool: "Bash", summary: "bun run test failed",
                status: .init(known: .error)),
        ]
    }
    return ActivityTabView(session: PreviewData.session(), model: DetailModel(loaders: loaders))
        .frame(width: 640, height: 420)
}

#Preview("Activity — empty") {
    ActivityTabView(session: PreviewData.session(), model: DetailModel(loaders: .stubbed()))
        .frame(width: 640, height: 420)
}
#endif
