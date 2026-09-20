import SwiftUI
import ShepherdKit

@MainActor enum MergeInputs {
    static var git: (AppModel) -> [String: GitState] = { _ in [:] }
    static var reviewing: (AppModel, String) -> Bool = { _, _ in false }
    static var planReviewBlocked: (AppModel, String) -> Bool = { _, _ in true }
    static var terminalEnded: (AppModel, String) -> Bool = { _, _ in true }
}
struct MergeQueueView: View {
    let app: AppModel
    let queue: BuildQueue
    let session: Session
    let store: SessionStore
    let model: MergeModel
    @State private var title = ""
    private var planning: Bool { session.planPhase?.rawValue == "planning" }
    private var ended: Bool { session.status.known == .archived || MergeInputs.terminalEnded(app, session.id) }
    var body: some View {
        GroupBox(L.t("native_merge_queue")) {
            VStack(alignment: .leading) {
                // Skipped resolves progress but never earns the green done glyph.
                ProgressView(value: Double(MergeRules.resolved(queue)), total: Double(max(1, queue.steps.count)))
                ForEach(queue.steps, id: \.id) { step in
                    HStack {
                        Image(systemName: step.status.known == .done ? "checkmark.circle" :
                            step.status.known == .skipped ? "minus.circle" : "circle")
                        MergeStepEditor(step: step) { title, detail in
                            var steps = queue.steps
                            guard let index = steps.firstIndex(where: { $0.id == step.id }) else { return }
                            steps[index].title = title; steps[index].detail = detail; write(steps)
                        }
                        Button { move(step.id, by: -1) } label: { Image(systemName: "arrow.up") }
                            .accessibilityLabel(L.t("native_merge_move_up"))
                        Button { move(step.id, by: 1) } label: { Image(systemName: "arrow.down") }
                            .accessibilityLabel(L.t("native_merge_move_down"))
                        Button(L.t("native_merge_remove")) { write(queue.steps.filter { $0.id != step.id }) }
                    }
                }
                TextField(L.t("native_merge_step"), text: $title)
                Button(L.t("native_merge_add")) {
                    var steps = queue.steps
                    steps.append(.init(id: UUID().uuidString, title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                        detail: "", status: .init(known: .pending), position: steps.count))
                    write(steps); title = ""
                }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.count > 200 || queue.steps.count >= 100)
                if MergeRules.canApprove(queue, status: session.status.rawValue, planning: planning,
                    reviewBlocked: MergeInputs.planReviewBlocked(app, session.id), ended: ended) {
                    Button(L.t("native_merge_approve")) {
                        model.perform { _ = try await store.client.approveBuildQueue(id: session.id) }
                    }
                }
                if MergeRules.canStart(queue, status: session.status.rawValue, planning: planning,
                    reviewBlocked: MergeInputs.planReviewBlocked(app, session.id), ended: ended) {
                    Button(L.t("buildqueue_start")) {
                        model.perform { try await store.client.replySession(id: session.id, text: L.t("buildqueue_start_steer")) }
                    }
                }
            }.disabled(model.busy || queue.steps.contains { $0.status.known == nil })
        }
    }
    private func move(_ id: String, by offset: Int) {
        var rows = queue.steps
        guard let index = rows.firstIndex(where: { $0.id == id }), rows.indices.contains(index + offset) else { return }
        rows.swapAt(index, index + offset); write(rows)
    }
    private func write(_ steps: [BuildStep]) {
        // Preserve the agent's stable IDs and statuses on replace. Unknown states are not edited.
        guard !model.busy, queue.steps.allSatisfy({ $0.status.known != nil }),
            steps.allSatisfy({ $0.status.known != nil }) else { return }
        let rows = steps.map { BuildStepInput(id: $0.id, title: $0.title, detail: $0.detail,
            status: .init(rawValue: $0.status.rawValue)) }
        model.perform { _ = try await store.client.putBuildQueue(id: session.id, body: .init(steps: rows)) }
    }
}
struct MergeStepEditor: View {
    let step: BuildStep
    let save: (String, String) -> Void
    @State private var title = ""
    @State private var detail = ""
    var body: some View {
        VStack {
            TextField(L.t("native_merge_step"), text: $title)
            TextField(L.t("native_merge_step_detail"), text: $detail)
            Button(L.t("common_save")) {
                save(title.trimmingCharacters(in: .whitespacesAndNewlines), detail)
            }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || title.count > 200 || detail.count > 4000
                || (title == step.title && detail == step.detail))
        }.onAppear { title = step.title; detail = step.detail }
        .onChange(of: step.title) { title = step.title }
        .onChange(of: step.detail) { detail = step.detail }
    }
}
struct MergeOverviewView: View {
    let app: AppModel
    let store: SessionStore
    let model: MergeModel
    var body: some View {
        MergeOverviewContent(app: app, store: store, model: model)
            .id(app.activationGeneration)
    }
}
private struct MergeOverviewContent: View {
    let app: AppModel
    let store: SessionStore
    let model: MergeModel
    @State private var trainOpen = false
    @State private var base = "main"
    @State private var trainPRs: [MergeReadyPR] = []
    @State private var excluded = 0
    @State private var clearPreview: ClearMergedPreview?
    @State private var clearOpen = false
    @State private var queue: [DrainQueuedItem] = []
    @State private var armed = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.t("native_merge_overview")).font(.headline)
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                ForEach(model.snapshot.automation, id: \.repoPath) { state in
                    Text(verbatim: "\(state.repoPath) · \(state.state ?? "—") · \(state.detail ?? "")")
                }
                ForEach(model.snapshot.drain, id: \.repoPath) { state in
                    HStack {
                        Text(verbatim: "\(state.repoPath) · \(state.inFlight)/\(state.max) · \(state.queued)")
                        if state.paused { Text(verbatim: state.reason ?? "—").foregroundStyle(.orange) }
                        Button(L.t("native_merge_queue")) {
                            model.perform(commit: { queue = $0 }) { try await store.client.listDrainQueue(repo: state.repoPath) }
                        }
                    }
                }
                ForEach(queue, id: \.number) { row in Text(verbatim: "#\(row.number) \(row.title)") }
                Button(L.t("native_merge_train")) {
                    let prs = MergeRules.ready(store.sessions, git: MergeInputs.git(app),
                        reviewing: Set(store.sessions.filter { MergeInputs.reviewing(app, $0.id) }.map(\.id)))
                    let chosen = MergeRules.train(prs)
                    trainPRs = chosen.prs; excluded = chosen.excluded
                    base = store.sessions.first(where: { $0.id == chosen.prs.first?.id })?.baseBranch ?? "main"
                    armed = false; trainOpen = true
                }
                Button(L.t("clearmerged_title")) {
                    model.perform(commit: { clearPreview = $0; clearOpen = true }) {
                        try await store.client.previewClearMerged()
                    }
                }
                MergeOwedView(model: model, client: store.client)
            }.padding()
        }
        .sheet(isPresented: $trainOpen) {
            VStack(alignment: .leading) {
                Text(L.t("native_merge_train"))
                ForEach(trainPRs) { pr in Text(verbatim: "#\(pr.number) \(pr.title) · \(pr.repo)") }
                Text(L.t("native_merge_excluded", String(excluded)))
                Text(L.t("native_merge_train_warning"))
                TextField(L.t("native_merge_base"), text: $base)
                Button(L.t("common_cancel")) { trainOpen = false }.keyboardShortcut(.cancelAction)
                Button(L.t("native_merge_train")) {
                    guard let repo = trainPRs.first?.repo, armed, !model.busy,
                        !base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    let request = MergeRules.request(repo: repo, base: base, prs: trainPRs)
                    model.perform { _ = try await store.create(request) }
                    trainOpen = false
                }.disabled(!armed || trainPRs.isEmpty || base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
            }.padding().task {
                armed = false
                do { try await Task.sleep(for: .milliseconds(350)); armed = true } catch { armed = false }
            }
        }
        .sheet(isPresented: $clearOpen) {
            if let preview = clearPreview {
                VStack(alignment: .leading) {
                    Text(L.t("clearmerged_title"))
                    ForEach(preview.ids, id: \.self) { id in Text(verbatim: id) }
                    if preview.probesUnavailable { Text(L.t("clearmerged_probes_unavailable")) }
                    if preview.leftovers > 0 { Text(L.t("clearmerged_leftovers", String(preview.leftovers))) }
                    Button(L.t("common_cancel")) { clearOpen = false }.keyboardShortcut(.cancelAction)
                    Button(L.t("clearmerged_confirm", String(preview.ids.count)), role: .destructive) {
                        guard !model.busy, !preview.ids.isEmpty else { return }
                        let ids = preview.ids
                        model.perform { _ = try await store.client.clearMergedSessions(body: .init(ids: ids)) }
                        clearOpen = false
                    }.disabled(preview.ids.isEmpty || model.busy)
                }.padding()
            }
        }
    }
}
