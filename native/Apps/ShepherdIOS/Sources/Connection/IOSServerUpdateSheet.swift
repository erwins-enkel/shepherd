import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// What the connection banner offers beyond Retry when the server and this app disagree about
/// the contract (#2987): update the server when it is behind, TestFlight when the app is older.
struct IOSServerUpdateOfferRow: View {
    let banner: BannerKind
    let lastError: ShepherdError?
    @Environment(AppModel.self) private var app

    /// Only a genuine contract mismatch is worth asking the server about. A mismatch the health
    /// call itself discovered shows as `.unhealthy`, so that counts when `lastError` says so.
    static func probes(_ banner: BannerKind, lastError: ShepherdError?) -> Bool {
        switch banner {
        case .contractMismatch: return true
        case .unhealthy:
            if case .contractMismatch = lastError { return true }
            return false
        case .offline, .clientTooOld, .needsLogin: return false
        }
    }

    var body: some View {
        if case .clientTooOld = banner {
            // The server said outright that this app is too old: nothing to ask it.
            IOSTestFlightButton()
        } else if Self.probes(banner, lastError: lastError), let model = app.extension(ServerUpdateModel.self) {
            switch model.offer {
            case .updateServer(let behind):
                Text(verbatim: L.t("native_server_update_behind", String(behind)))
                Button(L.t("native_server_update_action")) { Task { await model.open() } }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("connection-update-server")
            case .testFlight:
                Text(verbatim: L.t("native_server_update_testflight_hint"))
                IOSTestFlightButton()
            case .none:
                EmptyView()
            }
        }
    }
}

/// Opens TestFlight, or its App Store page when the TestFlight app is not installed.
struct IOSTestFlightButton: View {
    private static let app = URL(string: "itms-beta://")!
    private static let store = URL(string: "https://apps.apple.com/app/testflight/id899247664")!
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button(L.t("native_server_update_testflight_action")) {
            openURL(Self.app) { accepted in if !accepted { openURL(Self.store) } }
        }.accessibilityIdentifier("connection-open-testflight")
    }
}

/// Hosts the update sheet on a view that stays put while the server restarts: the banner
/// that opened it goes away as soon as the connection drops, and the sheet must not.
struct IOSServerUpdateSheetHost: View {
    @Bindable var model: ServerUpdateModel
    let serverName: String

    var body: some View {
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            .sheet(isPresented: $model.presented) { IOSServerUpdateSheet(model: model, serverName: serverName) }
    }
}

/// The web update modal's flow for the connected server: what changes, the dirty-tree
/// confirmation, the live deploy and why it failed.
struct IOSServerUpdateSheet: View {
    @Bindable var model: ServerUpdateModel
    let serverName: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    summary
                    content
                    if let error = model.error {
                        Text(verbatim: error).foregroundStyle(.red).accessibilityIdentifier("server-update-error")
                    }
                }
                .padding().frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L.t("native_server_update_title", serverName))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // Closing never stops a running update; the app keeps following it.
                    Button(L.t("common_close")) { model.presented = false }
                }
            }
        }
        .confirmationDialog(L.t("updatemodal_discard_and_update"), isPresented: $model.arming,
                            titleVisibility: .visible) {
            Button(L.t("updatemodal_discard_confirm_yes"), role: .destructive) { Task { await model.confirmDiscard() } }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("updatemodal_discard_confirm", String(model.dirty?.dirtyCount ?? 0)))
        }
        .accessibilityIdentifier("server-update-sheet")
    }

    @ViewBuilder private var summary: some View {
        if let status = model.status, status.behind > 0 {
            Text(verbatim: L.t("native_local_update_summary", String(status.behind),
                               status.current ?? "?", status.latest ?? "?"))
                .font(.headline)
            if !status.commits.isEmpty {
                DisclosureGroup(L.t("native_local_update_commits")) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(status.commits.prefix(10).enumerated()), id: \.offset) { _, commit in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(verbatim: String(commit.sha.prefix(7)))
                                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                                Text(verbatim: commit.subject).font(.callout)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        Text(verbatim: L.t("native_server_update_body")).font(.callout).foregroundStyle(.secondary)
    }

    @ViewBuilder private var content: some View {
        switch model.mode {
        case .loading:
            ProgressView()
        case .progress:
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(L.t("updatemodal_updating"))
                if let line = model.liveLogLine {
                    Text(verbatim: line).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                }
            }.accessibilityIdentifier("server-update-progress")
        case .clean:
            updateButton
        case .nowClean:
            Text(verbatim: L.t("updatemodal_now_clean"))
            updateButton
        case .dirty:
            dirtyList
            Button(L.t("updatemodal_discard_and_update"), role: .destructive) { model.arming = true }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("server-update-discard")
        case .tooLarge:
            dirtyList
            Text(verbatim: L.t("updatemodal_dirty_too_large"))
        case .rawLog:
            failure
        }
    }

    private var updateButton: some View {
        Button(L.t("updatemodal_update_now")) { Task { await model.runUpdate() } }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("server-update-now")
    }

    @ViewBuilder private var dirtyList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L.t("updatemodal_dirty_title")).font(.headline)
            Text(verbatim: L.t("updatemodal_dirty_body")).font(.callout)
            if model.staleHint {
                Text(verbatim: L.t("updatemodal_dirty_stale")).foregroundStyle(.orange)
            }
            if let dirty = model.dirty {
                Text(verbatim: L.t("updatemodal_dirty_files_head")).font(.subheadline.bold())
                ForEach(Array(dirty.dirtyFiles.enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line).font(.caption.monospaced()).textSelection(.enabled)
                }
                let more = dirty.dirtyCount - dirty.dirtyFiles.count
                if more > 0 { Text(verbatim: L.t("updatemodal_dirty_files_more", String(more))).font(.caption) }
            }
        }.accessibilityIdentifier("server-update-dirty")
    }

    private var failure: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: L.t("updatemodal_deploy_failed"))
            if let code = model.deploy?.exitCode {
                Text(verbatim: L.t("updatemodal_exit_code", String(code))).font(.caption).foregroundStyle(.secondary)
            }
            if let log = model.deploy?.log, !log.isEmpty {
                Text(verbatim: L.t("updatemodal_deploy_log")).font(.subheadline.bold())
                Text(verbatim: log).font(.caption.monospaced()).textSelection(.enabled)
            }
            Button(L.t("updatemodal_retry")) { Task { await model.runUpdate() } }
                .accessibilityIdentifier("server-update-retry")
        }.accessibilityIdentifier("server-update-failed")
    }
}
