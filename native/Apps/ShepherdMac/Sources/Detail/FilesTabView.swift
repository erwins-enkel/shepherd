import ShepherdKit
import SwiftUI

/// The cumulative path behind each breadcrumb crumb. The root crumb carries `nil`, which is what
/// `DetailModel.browse(session:source:path:)` sends to list the root.
enum FilesBreadcrumb {
    static func trail(_ path: String) -> [(label: String, path: String?)] {
        var trail: [(label: String, path: String?)] = [(label: "", path: nil)]
        var cumulative = ""
        for segment in path.split(separator: "/") where !segment.isEmpty {
            cumulative = cumulative.isEmpty ? String(segment) : "\(cumulative)/\(segment)"
            trail.append((label: String(segment), path: cumulative))
        }
        return trail
    }
}

/// A read-only browser over the session's two file roots — the native reading of
/// `FilesPanel.svelte`, minus upload and download (out of scope for this stream).
///
/// One directory at a time, exactly like the web panel: the server answers one listing per
/// request rather than a tree, so a directory is only fetched once the operator opens it.
struct FilesTabView: View {
    let session: Session
    let model: DetailModel
    @State private var source: DetailModel.FilesSource = .scratchpad
    /// The path the tab most recently asked for — kept even through `.loading`/`.failed`, so a
    /// failed read's Retry (and the breadcrumb itself) does not collapse back to the root.
    @State private var currentPath: String?

    private var state: Loaded<DetailModel.FilesPayload> { model.files[session.id] ?? .loading }
    /// Only the listing for the source currently selected — a stale listing from the other
    /// source must not flash under the new source's breadcrumb while the fresh read is in
    /// flight.
    private var listing: BrowseListing? {
        guard let payload = state.value, payload.source == source else { return nil }
        return payload.listing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            picker
            breadcrumb
            Divider()
            DetailStateView(state: phase, retry: { browse(currentPath) }) {
                List(listing?.entries ?? [], id: \.path) { entry in row(entry) }
                    .listStyle(.inset)
                    .accessibilityIdentifier("detail-files-list")
            }
        }
        .accessibilityIdentifier("detail-tab-files")
        .task(id: DetailTaskKey(session: session.id, model: model)) {
            source = .scratchpad
            currentPath = nil
            await model.browse(session: session.id, source: .scratchpad, path: nil)
        }
    }

    /// The source switch and Refresh share one row. Refresh lives here rather than in the window
    /// toolbar — see `DetailRefreshBar` for why that is not negotiable.
    private var picker: some View {
        DetailRefreshBar(
            title: L.t("native_detail_refresh"),
            isDisabled: state.isLoading,
            accessibilityID: "detail-files-refresh",
            action: { browse(currentPath) }
        ) {
            Picker("", selection: sourceBinding) {
                Text(verbatim: L.t("files_source_scratchpad"))
                    .tag(DetailModel.FilesSource.scratchpad)
                Text(verbatim: L.t("files_source_worktree"))
                    .tag(DetailModel.FilesSource.worktree)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 220)
        }
    }

    /// A custom binding rather than `.onChange(of: source)`: `.task(id:)` above also resets
    /// `source` to `.scratchpad` on every session/model change, and a plain `onChange` would fire
    /// for that reset too whenever the operator had left the worktree source selected — issuing a
    /// second, redundant browse alongside the one `.task` already makes.
    private var sourceBinding: Binding<DetailModel.FilesSource> {
        Binding(
            get: { source },
            set: { newValue in
                guard newValue != source else { return }
                source = newValue
                browse(nil)
            })
    }

    private var breadcrumb: some View {
        let trail = FilesBreadcrumb.trail(currentPath ?? "")
        return HStack(spacing: 4) {
            ForEach(Array(trail.enumerated()), id: \.offset) { index, crumb in
                if index > 0 {
                    Text(verbatim: "/").foregroundStyle(.tertiary)
                }
                let label = index == 0 ? rootLabel : crumb.label
                if index == trail.count - 1 {
                    Text(verbatim: label).foregroundStyle(.primary)
                } else {
                    Button(label) { browse(crumb.path) }
                        .buttonStyle(.link)
                }
            }
            Spacer()
        }
        .font(.caption.monospaced())
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .accessibilityIdentifier("detail-files-breadcrumb")
    }

    /// The root crumb reuses the source-switch label rather than a dedicated key: `KEYS_DETAIL`
    /// carries no `files_root_crumb`/`files_worktree_root_crumb` for this build, and "Scratchpad"
    /// / "Worktree" already says exactly what the root of each source is.
    private var rootLabel: String {
        source == .scratchpad ? L.t("files_source_scratchpad") : L.t("files_source_worktree")
    }

    private var phase: DetailStatePhase { Self.phase(for: state, source: source, listing: listing) }

    /// Lifted out of `body` so the mapping is assertable without hosting a view. Takes the
    /// already-filtered `listing` (not `state.value` directly) so a `.ready` payload left over
    /// from the source the operator just switched away from still reads as loading, not content.
    static func phase(
        for state: Loaded<DetailModel.FilesPayload>, source: DetailModel.FilesSource,
        listing: BrowseListing?
    ) -> DetailStatePhase {
        if state.failure != nil {
            return .failed(
                source == .scratchpad ? L.t("files_load_error") : L.t("files_worktree_load_error"))
        }
        guard let listing else { return .loading }
        return listing.entries.isEmpty
            ? .empty(source == .scratchpad ? L.t("files_empty") : L.t("files_worktree_empty"))
            : .content
    }

    @ViewBuilder
    private func row(_ entry: BrowseEntry) -> some View {
        let outside = entry.linkOutside == true
        HStack(spacing: 8) {
            // An open enum: anything this build does not recognise as a directory reads as a
            // file rather than disappearing from the list.
            Text(verbatim: outside ? "↗" : (entry._type.known == .dir ? "▸" : "▢"))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if entry._type.known == .dir, !outside {
                Button(entry.name) { browse(entry.path) }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(verbatim: entry.name)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(outside ? .secondary : .primary)
                    .help(outside ? L.t("files_link_outside_title") : "")
            }
            Text(verbatim: created(entry))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 160, alignment: .trailing)
                .help(entry.createdMs == nil ? L.t("files_created_unknown") : "")
        }
        .accessibilityIdentifier("detail-files-entry-\(entry.name)")
    }

    private func created(_ entry: BrowseEntry) -> String {
        guard let ms = entry.createdMs else { return "—" }
        return Date(timeIntervalSince1970: Double(ms) / 1000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    private func browse(_ path: String?) {
        currentPath = path
        Task { await model.browse(session: session.id, source: source, path: path) }
    }
}

#if DEBUG
#Preview("Files — a directory listing") {
    var loaders = DetailModel.Loaders.stubbed()
    loaders.scratchpad = { _, path in
        BrowseListing(
            path: path ?? "", parent: path == nil ? nil : "",
            entries: [
                BrowseEntry(name: "notes", _type: .init(known: .dir), path: "notes"),
                BrowseEntry(
                    name: "output.log", _type: .init(known: .file), path: "output.log",
                    createdMs: 1_700_000_000_000),
                BrowseEntry(
                    name: "elsewhere", _type: .init(known: .file), path: "elsewhere",
                    linkOutside: true),
            ])
    }
    return FilesTabView(session: PreviewData.session(), model: DetailModel(loaders: loaders))
        .frame(width: 640, height: 420)
}

#Preview("Files — empty directory") {
    FilesTabView(session: PreviewData.session(), model: DetailModel(loaders: .stubbed()))
        .frame(width: 640, height: 420)
}
#endif
