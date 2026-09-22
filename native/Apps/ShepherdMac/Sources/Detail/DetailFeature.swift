import ShepherdAppCore
import SwiftUI
import ShepherdKit

/// Stream S2's entry point. The S0 install site calls this exactly once at launch.
///
/// Idempotent by construction, not by a guard flag: `AppModel.register(_:)` is keyed by
/// extension type and `DetailTabRegistry.register(_:)` by tab id, so a second call does exactly
/// what the first one did and nothing more — see both seams' own doc comments.
enum DetailFeature {
    @MainActor
    static func install(_ app: AppModel) {
        MacStreamHost.configure()
        CoreStreamInstallers.installDetail(into: app)
    }

    @MainActor
    static func installTabs(_ app: AppModel) {
        // One per SessionStore: AppModel builds it in activate(_:) and tears it down with the
        // store, so every cache dies with the server it belongs to.
        DetailTabRegistry.register(ActivityTab())
        DetailTabRegistry.register(DiffTab())
        DetailTabRegistry.register(FilesTab())
        DetailTabRegistry.register(GitTab())
    }

    /// The model for the active store, or nil between activations. Every tab view starts here.
    @MainActor
    static func model(_ app: AppModel) -> DetailModel? { app.extension(DetailModel.self) }
}

/// The Refresh control every detail tab shows, rendered *inside* the tab instead of in the
/// window toolbar.
///
/// It used to be a `ToolbarItem`. `SessionDetailView` hosts the tabs in a `TabView`, which keeps
/// every visited child alive, and a child's `.toolbar` contribution is never withdrawn when that
/// child goes off screen: the window grew one Refresh button per tab the operator had ever
/// opened, and AppKit eventually threw out of
/// `-[NSToolbar _insertNewItemWithItemIdentifier:atIndex:propertyListRepresentation:notifyFlags:]`
/// and killed the app — reproduced live, four tabs deep. Keeping the control in the tab's own
/// body keeps it out of the AppKit toolbar bridge entirely, and no stream needs to own the
/// window's toolbar to have one.
struct DetailRefreshBar<Leading: View>: View {
    let title: String
    let isDisabled: Bool
    let accessibilityID: String
    let action: () -> Void
    @ViewBuilder let leading: () -> Leading

    var body: some View {
        HStack(spacing: 10) {
            leading()
            Spacer(minLength: 0)
            Button(title, systemImage: "arrow.clockwise", action: action)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .disabled(isDisabled)
                .help(title)
                .accessibilityIdentifier(accessibilityID)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }
}

extension DetailRefreshBar where Leading == EmptyView {
    init(
        title: String, isDisabled: Bool, accessibilityID: String,
        action: @escaping () -> Void
    ) {
        self.init(
            title: title, isDisabled: isDisabled, accessibilityID: accessibilityID,
            action: action, leading: { EmptyView() })
    }
}

/// The loading / empty / error chrome every detail tab shares, so the four cannot drift apart on
/// how a failure reads.
struct DetailStateView<Content: View>: View {
    let state: DetailStatePhase
    let retry: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        switch state {
        case .loading:
            ProgressView(L.t("common_loading"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("detail-state-loading")
        case .empty(let message):
            ContentUnavailableView(message, systemImage: "tray")
                .accessibilityIdentifier("detail-state-empty")
        case .failed(let message):
            VStack(spacing: 12) {
                Text(verbatim: message).foregroundStyle(.secondary)
                Button(L.t("common_retry"), action: retry)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("detail-state-error")
        case .content:
            content()
        }
    }
}

struct ActivityTab: DetailTab {
    let id = "activity"
    var title: String { L.t("native_detail_tab_activity") }
    let systemImage = "list.bullet.rectangle"
    let order = 10

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(ActivityTabView(session: session, model: model))
    }
}

struct DiffTab: DetailTab {
    let id = "diff"
    var title: String { L.t("native_detail_tab_diff") }
    let systemImage = "plusminus"
    let order = 20

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(DiffTabView(session: session, model: model))
    }
}

struct FilesTab: DetailTab {
    let id = "files"
    var title: String { L.t("native_detail_tab_files") }
    let systemImage = "folder"
    let order = 30

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(FilesTabView(session: session, model: model))
    }
}

struct GitTab: DetailTab {
    let id = "git"
    var title: String { L.t("native_detail_tab_git") }
    let systemImage = "arrow.triangle.pull"
    let order = 40

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(GitTabView(session: session, model: model, store: store))
    }
}
