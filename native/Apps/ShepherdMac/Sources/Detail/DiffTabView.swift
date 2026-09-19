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

    private var state: Loaded<DetailModel.DiffPayload> { model.diff[session.id] ?? .loading }
    private var files: [DiffFile] { state.value?.result.files ?? [] }
    private var notes: [DiffNote] { state.value?.notes ?? [] }
    private var isRefreshing: Bool { model.isRefreshing(.diff, session: session.id) }

    var body: some View {
        DetailStateView(state: phase, retry: reload) {
            HSplitView {
                fileList.frame(minWidth: 200, idealWidth: 260, maxWidth: 380)
                VStack(alignment: .leading, spacing: 0) {
                    header
                    // Panel-level review findings: a verdict that belongs to no single file
                    // arrives with an empty path, exactly as the web panel reads it.
                    noteList(notes.filter { $0.kind.known == .review && $0.path.isEmpty })
                        .padding(.horizontal, 12)
                    Divider()
                    ScrollView { fileBody(for: selected).padding(.horizontal, 12) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .accessibilityIdentifier("detail-tab-diff")
        .toolbar {
            // An explicit id: four detail tabs each add a Refresh item, and SwiftUI matches
            // toolbar items by identity when one tab replaces another.
            ToolbarItem(id: "detail-diff-refresh") {
                Button(L.t("diff_refresh"), systemImage: "arrow.clockwise", action: reload)
                    .labelStyle(.iconOnly)
                    .disabled(state.isLoading || isRefreshing)
            }
        }
        .task(id: DetailTaskKey(session: session.id, model: model)) {
            selectedPath = nil
            await model.poll(.diff, session: session.id)
        }
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
            ? .empty(L.t("diff_empty", payload.result.base))
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
                noteList(notes.filter { $0.path == file.path && $0.lineNumber == nil })
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

    /// Parsed per body pass rather than cached: `DiffFile.patch` is capped server-side, and a
    /// cache here would have to be invalidated on every poll tick that moves the diff anyway.
    @ViewBuilder
    private func hunks(of file: DiffFile) -> some View {
        let parsed = UnifiedPatch.parse(file.patch ?? "")
        if !parsed.hunks.isEmpty {
            ForEach(Array(parsed.hunks.enumerated()), id: \.offset) { index, hunk in
                hunkView(hunk, file: file)
                    .accessibilityIdentifier("detail-diff-hunk-\(index)")
            }
        } else if !parsed.raw.isEmpty {
            // Nothing parsed but there was text: show it verbatim rather than claim the file is
            // unchanged. A patch the operator cannot read is still a patch they can copy.
            Text(verbatim: parsed.raw)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            note(L.t("diff_note_no_changes"))
        }
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
            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                lineView(line)
                // An agent annotation sits under the line it is anchored to, the way the web
                // panel renders it inline rather than in a side list.
                noteList(anchored(line, file: file)).padding(.leading, 24)
            }
        }
    }

    /// Notes anchored to this exact line. `side` decides which number to match: an `additions`
    /// note counts the new side, a `deletions` note the old one.
    private func anchored(_ line: UnifiedPatch.Line, file: DiffFile) -> [DiffNote] {
        notes.filter { note in
            guard note.path == file.path, let number = note.lineNumber else { return false }
            return switch note.side?.known {
            case .deletions: line.oldNumber == number
            default: line.newNumber == number
            }
        }
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
