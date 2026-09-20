import Foundation
import ShepherdKit
import SwiftUI

/// The session branch against its base: a file list on the left, unified hunks on the right,
/// annotations inline — the native reading of `DiffPanel.svelte`. Monospace and syntax-neutral on
/// purpose: no highlighter ships with this app.
///
/// `GET /diff` sends no parsed hunks, only `DiffFile.patch`, so every file's text goes through
/// `UnifiedPatch.parse` here. The view reads the model and never writes to it: the 15 s poll and
/// the Refresh button both go through `DetailModel`, which keeps the last good diff on screen
/// while a tick is in flight.
struct DiffTabView: View {
    let session: Session
    let model: DetailModel
    @State private var selectedPath: String?
    /// Where every note renders and every file's patch parses to — recomputed explicitly (on
    /// first appearance and whenever the diff payload's `revision` moves), never inline in
    /// `body`, so a 15 s poll tick that repaints an UNCHANGED diff does not reparse every file's
    /// patch or re-bucket every note on every render pass.
    ///
    /// `revision`, not `result.head`: `head` is the session BRANCH NAME, so it moves exactly
    /// once (nil → branch) and never again — the parsed hunks this holds then stayed frozen at
    /// the agent's first commit while the file list and the +/− counts kept updating around
    /// them. And `revision`, not the payload itself, because `onChange(of:)` compares its value
    /// every render pass and a diff payload is O(patch bytes) to compare.
    @State private var layout = DiffAnnotationLayout()

    private var state: Loaded<DetailModel.DiffPayload> { model.diff[session.id] ?? .loading }
    private var files: [DiffFile] { state.value?.result.files ?? [] }
    private var notes: [DiffNote] { state.value?.notes ?? [] }
    private var isRefreshing: Bool { model.isRefreshing(.diff, session: session.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DetailRefreshBar(
                title: L.t("diff_refresh"),
                isDisabled: state.isLoading || isRefreshing,
                accessibilityID: "detail-diff-refresh",
                action: reload)
            content
        }
        .accessibilityIdentifier("detail-tab-diff")
        .task(id: DetailTaskKey(session: session.id, model: model)) {
            selectedPath = nil
            recomputeLayout()
            await model.poll(.diff, session: session.id)
        }
        .onChange(of: state.value?.revision) { _, _ in recomputeLayout() }
    }

    private var content: some View {
        DetailStateView(state: phase, retry: reload) {
            HSplitView {
                fileList.frame(minWidth: 200, idealWidth: 260, maxWidth: 380)
                VStack(alignment: .leading, spacing: 0) {
                    header
                    // Panel-level findings: a verdict that belongs to no single file arrives with
                    // an empty path, exactly as the web panel reads it — plus any note whose path
                    // names a file this diff no longer carries, grouped here rather than dropped.
                    noteList(layout.panel)
                        .padding(.horizontal, 12)
                    Divider()
                    ScrollView { fileBody(for: selected).padding(.horizontal, 12) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    /// The one place `DiffAnnotationLayout.partition` (and, inside it, `UnifiedPatch.parse`) is
    /// called: on first appearance for whatever the model already has cached, and again whenever
    /// the model stamps a new `DiffPayload.revision` — which it does exactly when the diff's
    /// content changed. Never from `body`, which a poll tick re-evaluates every 15 s whether or
    /// not the diff actually changed.
    private func recomputeLayout() {
        layout = DiffAnnotationLayout.partition(notes: notes, files: files)
    }

    /// The row the operator picked, or the first file — a diff with no selection still shows
    /// something rather than an empty pane.
    private var selected: DiffFile? {
        files.first { $0.path == selectedPath } ?? files.first
    }

    private var phase: DetailStatePhase { Self.phase(for: state) }

    /// Lifted out of `body` so the mapping is assertable without hosting a view.
    static func phase(for state: Loaded<DetailModel.DiffPayload>) -> DetailStatePhase {
        if let failure = state.failure { return .failed(failure) }
        guard let payload = state.value else { return .loading }
        return payload.result.files.isEmpty
            // `diff_empty` names the ref the branch is compared against (`baseRef`, e.g.
            // "origin/main"); `diff_stale` below names the plain branch (`base`) — the same
            // split the web panel makes.
            ? .empty(L.t("diff_empty", payload.result.baseRef))
            : .content
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(
                verbatim: "\(files.count) · +\(files.reduce(0) { $0 + $1.additions })"
                    + " −\(files.reduce(0) { $0 + $1.deletions })"
            )
            .font(.caption.monospaced())
            if state.value?.result.fetchFailed == true {
                Label(
                    L.t("diff_stale", state.value?.result.base ?? ""),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
            Spacer()
            if isRefreshing {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var fileList: some View {
        List(files, id: \.path, selection: $selectedPath) { file in
            HStack(spacing: 8) {
                Text(verbatim: glyph(file.status))
                    .font(.caption.monospaced().weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14, alignment: .leading)
                Text(verbatim: file.path).font(.callout).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                Text(verbatim: "+\(file.additions) −\(file.deletions)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .tag(file.path)
        }
        .accessibilityIdentifier("detail-diff-files")
    }

    /// An open enum: a status this build does not know keeps its first wire character rather than
    /// pretending to be one of the four it does.
    private func glyph(_ status: Components.Schemas.DiffFileStatus) -> String {
        switch status.known {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case nil: String(status.rawValue.prefix(1)).uppercased()
        }
    }

    @ViewBuilder
    private func fileBody(for file: DiffFile?) -> some View {
        if let file {
            VStack(alignment: .leading, spacing: 10) {
                if file.oldPath != nil, file.oldPath != file.path {
                    Text(verbatim: "\(file.oldPath ?? "") → \(file.path)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                // File-level findings first, then the hunks with their per-line notes.
                noteList(layout.fileLevel[file.path] ?? [])
                if file.binary {
                    note(L.t("diff_note_binary"))
                } else if file.truncated == true {
                    note(L.t("diff_note_truncated"))
                } else {
                    hunks(of: file)
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Reads `layout.hunks` — parsed once in `recomputeLayout()`, not on every body pass — and
    /// realises hunks lazily: a large file can carry thousands of lines, and eagerly building
    /// every row for a file the operator has scrolled past wastes both time and memory.
    @ViewBuilder
    private func hunks(of file: DiffFile) -> some View {
        let parsed = layout.hunks[file.path] ?? UnifiedPatch.parse(file.patch ?? "")
        if !parsed.hunks.isEmpty {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(Array(parsed.hunks.enumerated()), id: \.offset) { index, hunk in
                    hunkView(hunk, file: file)
                        .accessibilityIdentifier("detail-diff-hunk-\(index)")
                }
            }
        } else if let text = Self.verbatimText(parsed: parsed, patch: file.patch) {
            // Nothing parsed but there was text: show it verbatim rather than claim the file is
            // unchanged. A patch the operator cannot read is still a patch they can copy.
            Text(verbatim: text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("detail-diff-verbatim")
        } else {
            note(L.t("diff_note_no_changes"))
        }
    }

    /// What to show for a file that produced no hunks, or nil when there is genuinely nothing to
    /// show. Lifted out of `body` so it is assertable without hosting a view.
    ///
    /// `UnifiedPatch.raw` covers a patch that produced no `File` at all. It does NOT cover a
    /// patch whose file headers parsed but whose hunks did not (`diff --git`/`---`/`+++` and
    /// then a malformed `@@`): that yields one `File`, zero hunks and — because `raw` is
    /// suppressed whenever anything parsed — an empty `raw`, so the tab claimed
    /// `diff_note_no_changes` for a file the list right beside it says has changes. The file's
    /// own patch text is the answer there. A pure rename or a mode-only change sends no patch
    /// text at all and still reads, correctly, as no changes. Binary and truncated files never
    /// reach here — `fileBody(for:)` answers those first.
    static func verbatimText(parsed: UnifiedPatch, patch: String?) -> String? {
        if !parsed.raw.isEmpty { return parsed.raw }
        guard let patch, !patch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return patch
    }

    private func note(_ text: String) -> some View {
        Text(verbatim: text).font(.callout).foregroundStyle(.secondary)
    }

    private func hunkView(_ hunk: UnifiedPatch.Hunk, file: DiffFile) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: hunk.header)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .padding(.vertical, 4)
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    lineView(line)
                    // An agent annotation sits under the line it is anchored to, the way the web
                    // panel renders it inline rather than in a side list.
                    noteList(perLineNotes(line, file: file)).padding(.leading, 24)
                }
            }
        }
    }

    /// `layout.perLine` lookups, not a scan of every note per line: a context line carries both
    /// an old and a new number, so both keys are checked.
    private func perLineNotes(_ line: UnifiedPatch.Line, file: DiffFile) -> [DiffNote] {
        var result: [DiffNote] = []
        if let old = line.oldNumber {
            result += layout.perLine[.init(path: file.path, side: .old, number: old)] ?? []
        }
        if let new = line.newNumber {
            result += layout.perLine[.init(path: file.path, side: .new, number: new)] ?? []
        }
        return result
    }

    private func lineView(_ line: UnifiedPatch.Line) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(verbatim: line.oldNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
                .foregroundStyle(.secondary)
            Text(verbatim: line.newNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
                .foregroundStyle(.secondary)
            Text(verbatim: marker(line.kind) + line.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .font(.system(.caption, design: .monospaced))
        .background(background(line.kind))
    }

    private func marker(_ kind: UnifiedPatch.Line.Kind) -> String {
        switch kind {
        case .add: "+"
        case .del: "-"
        case .context: " "
        }
    }

    private func background(_ kind: UnifiedPatch.Line.Kind) -> Color {
        switch kind {
        case .add: .green.opacity(0.14)
        case .del: .red.opacity(0.14)
        case .context: .clear
        }
    }

    @ViewBuilder
    private func noteList(_ list: [DiffNote]) -> some View {
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(list.enumerated()), id: \.offset) { _, note in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(
                            verbatim: note.kind.known == .review
                                ? L.t("viewport_diff_annotation_review")
                                : L.t("native_detail_annotation_agent")
                        )
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.secondary.opacity(0.15), in: Capsule())
                        Text(verbatim: note.text)
                            .font(.caption)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func reload() { Task { await model.load(.diff, session: session.id) } }
}

#if DEBUG
/// A diff with two files, a rename, a binary file and both kinds of annotation.
@MainActor
private func diffPreviewLoaders() -> DetailModel.Loaders {
    var loaders = DetailModel.Loaders.stubbed()
    loaders.diff = { _ in
        DiffResult(
            base: "main", baseRef: "origin/main", head: "abc123", fetchFailed: true,
            truncated: false,
            files: [
                DiffFile(
                    path: "src/toolbar.ts", status: .init(known: .modified), additions: 2,
                    deletions: 1, binary: false,
                    patch: """
                        @@ -10,3 +10,4 @@ function toolbar() {
                           const el = document.querySelector(".bar");
                        -  el.hidden = true;
                        +  el.hidden = false;
                        +  el.dataset.ready = "1";
                        """),
                DiffFile(
                    path: "assets/logo.png", oldPath: "assets/old-logo.png",
                    status: .init(known: .renamed), additions: 0, deletions: 0, binary: true),
            ])
    }
    loaders.annotations = { _ in
        [
            DiffNote(
                path: "", kind: .init(known: .review),
                text: "The toolbar still ships without a keyboard path."),
            DiffNote(
                path: "src/toolbar.ts", kind: .init(known: .agent), text: "flipped the guard",
                side: .init(known: .additions), lineNumber: 12, tool: "Edit"),
        ]
    }
    return loaders
}

#Preview("Diff — files and annotations") {
    DiffTabView(session: PreviewData.session(), model: DetailModel(loaders: diffPreviewLoaders()))
        .frame(width: 900, height: 520)
}

#Preview("Diff — empty") {
    DiffTabView(session: PreviewData.session(), model: DetailModel(loaders: .stubbed()))
        .frame(width: 900, height: 520)
}
#endif
