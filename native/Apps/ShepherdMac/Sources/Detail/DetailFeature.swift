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
        // One per SessionStore: AppModel builds it in activate(_:) and tears it down with the
        // store, so every cache dies with the server it belongs to.
        app.register(DetailModel.self)
        DetailTabRegistry.register(ActivityTab())
    }

    /// The model for the active store, or nil between activations. Every tab view starts here.
    @MainActor
    static func model(_ app: AppModel) -> DetailModel? { app.extension(DetailModel.self) }
}

/// The identity a detail tab's `.task(id:)` keys on: the selected session **and** the model
/// showing it.
///
/// The session id alone is not enough. `AppModel` builds a fresh `DetailModel` per activation, so
/// a profile switch can leave the same session id selected in front of an empty cache — and a
/// task that did not re-run would sit on loading chrome nothing ever fills.
struct DetailTaskKey: Hashable {
    let session: String
    let model: ObjectIdentifier

    init(session: String, model: DetailModel) {
        self.session = session
        self.model = ObjectIdentifier(model)
    }
}

/// What a tab should render. A tab maps its own `Loaded` value onto this.
enum DetailStatePhase: Equatable {
    case loading
    case empty(String)
    case failed(String)
    case content
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
