import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct ActivityView: View {
    let session: Session
    let model: DetailModel
    @Environment(AppModel.self) private var app
    private var state: Loaded<[ActivityEntry]> { model.activity[session.id] ?? .loading }
    static func phase(for state: Loaded<[ActivityEntry]>) -> DetailStatePhase {
        if let failure = state.failure { return .failed(failure) }
        guard let entries = state.value else { return .loading }
        return entries.isEmpty ? .empty(L.t("activity_empty")) : .content
    }
    var body: some View {
        Section(L.t("native_detail_tab_activity")) {
            switch Self.phase(for: state) {
            case .loading: ProgressView().accessibilityIdentifier("activity-loading")
            case .empty(let message): Text(verbatim: message).foregroundStyle(.secondary)
            case .failed(let message): Text(verbatim: message).foregroundStyle(.red)
            case .content:
                ForEach(Array((state.value ?? []).enumerated()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(verbatim: entry.tool).font(.caption.monospaced().bold())
                            Spacer()
                            Text(Date(timeIntervalSince1970: Double(entry.ts) / 1000), style: .time)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Text(verbatim: entry.summary).textSelection(.enabled)
                            .foregroundStyle(entry.status.known == .error ? .red : .primary)
                    }.accessibilityIdentifier("activity-entry")
                }
            }
            Button(L.t("native_detail_refresh")) { Task { await reload() } }
                .disabled(state.isLoading || model.isRefreshing(.activity, session: session.id))
                .accessibilityIdentifier("detail-activity-refresh")
        }
        .accessibilityIdentifier("detail-activity-list")
        .task(id: DetailTaskKey(session: session.id, model: model)) {
            guard isCurrent else { return }
            await model.poll(.activity, session: session.id)
        }
    }
    private var isCurrent: Bool {
        app.selectedSessionID == session.id && app.extension(DetailModel.self) === model && model.isActive
    }
    private func reload() async {
        guard isCurrent else { return }
        await model.load(.activity, session: session.id)
    }
}
