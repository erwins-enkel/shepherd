import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// The terminal detail tab. Order 0: the terminal is what the operator came for.
struct TerminalTab: DetailTab {
    let id = "terminal"
    var title: String { L.t("native_terminal_tab_title") }
    let systemImage = "terminal"
    let order = 0

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        // Backticks: `extension` is a keyword, and the S0-prep accessor is
        // spelled with them.
        guard let controller = app.`extension`(TerminalController.self) else {
            // The extension is registered by `TerminalInstall.install(into:)`;
            // if it is missing the app is mid-teardown, so render nothing
            // rather than build a model against a dead store.
            return AnyView(EmptyView())
        }
        // Keyed by id so SwiftUI rebuilds the pane — and therefore re-runs
        // `attach` — when the operator selects a different session.
        return AnyView(TerminalPane(model: controller.model(for: session.id)).id(session.id))
    }
}

/// The stream's single entry point. The integration lane calls this from
/// `StreamRegistrations.installAll(into:)`; the tests call it directly.
///
/// No idempotence flag of its own: `DetailTabRegistry.register` is keyed by tab
/// id and `AppModel.register` by `ObjectIdentifier`, so both are last-wins.
@MainActor
enum TerminalInstall {
    static func install(into app: AppModel) {
        MacStreamHost.configure()
        CoreStreamInstallers.installTerminal(into: app)
    }

    @MainActor
    static func installTab(_ app: AppModel) {
        DetailTabRegistry.register(TerminalTab())
    }
}
