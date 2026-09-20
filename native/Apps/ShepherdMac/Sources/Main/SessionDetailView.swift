import SwiftUI
import ShepherdKit

/// The detail pane: a fixed header, then one tab per registered `DetailTab`.
///
/// The store and the model come from the environment rather than from
/// initialiser parameters, so adding a tab never changes this view's signature
/// and no stream has to touch `MainWindow` to hand them over.
struct SessionDetailView: View {
    let session: Session?
    @Environment(AppModel.self) private var model

    var body: some View {
        // `model.store` is non-nil for every render inside `MainWindow`, which is
        // mounted only while a store exists; the nil branch is the same "nothing
        // selected" state as before.
        if let session, let store = model.store {
            VStack(alignment: .leading, spacing: 16) {
                header(session)
                tabs(session, store)
            }
            .padding(24)
            .accessibilityIdentifier("session-detail")
        } else {
            ContentUnavailableView(L.t("native_detail_no_selection"), systemImage: "sidebar.left")
        }
    }

    /// The registered tabs, or — while the built-in prompt tab is the only one —
    /// its content on its own. A `TabView` with a single item still draws the
    /// tab bar, so until a stream registers a tab the pane would carry a row of
    /// chrome with nothing to switch to.
    ///
    /// Both branches render the tab's own view, so `detail-tab-prompt` and every
    /// other identifier a tab sets survive the switch untouched.
    @ViewBuilder
    private func tabs(_ session: Session, _ store: SessionStore) -> some View {
        let registered = DetailTabRegistry.tabs
        switch DetailTabRegistry.layout(forTabCount: registered.count) {
        case .single:
            if let only = registered.first {
                only.makeView(session: session, store: store, app: model)
            }
        case .tabbed:
            // NSTabView's preferred size for the terminal can exceed the window.
            // Do not let that preference become NavigationSplitView's minimum:
            // the header and action bar keep their space, and the tabs receive
            // exactly the remaining viewport. Their lists/scroll views and the
            // terminal then resize within it instead of pushing chrome offscreen.
            GeometryReader { geometry in
                TabView {
                    ForEach(registered, id: \.id) { tab in
                        tab.makeView(session: session, store: store, app: model)
                            .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }
    }

    private func header(_ session: Session) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: session.desig).font(.title3.monospaced().weight(.semibold))
            Text(verbatim: session.name).font(.title3)
                .lineLimit(1)
            Spacer()
            Text(verbatim: L.t("native_detail_status_label"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: SessionStatusStyle.label(session.status))
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(SessionStatusStyle.tint(session.status).opacity(0.18), in: Capsule())
                .foregroundStyle(SessionStatusStyle.tint(session.status))
        }
    }
}

#if DEBUG
// The tab body previews on its own; `SessionDetailView` needs a live store to
// show tabs at all, which a preview has no way to produce.
#Preview("Prompt tab") {
    PromptTabView(session: PreviewData.session()).frame(width: 720, height: 520)
}

#Preview("No selection") {
    // Its own defaults suite and an in-memory credential store, so a preview
    // never reads the operator's real profiles or Keychain.
    SessionDetailView(session: nil)
        .environment(
            AppModel(
                defaults: UserDefaults(suiteName: "preview-\(UUID().uuidString)")!,
                credentials: InMemoryCredentialStore()))
        .frame(width: 720, height: 520)
}
#endif
