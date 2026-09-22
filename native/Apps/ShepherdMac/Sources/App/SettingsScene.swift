import ShepherdAppCore
import SwiftUI

/// The body of the `Settings` scene.
///
/// A `TabView` rather than a `NavigationSplitView`: macOS settings windows are tabbed, and the
/// placeholder branch keeps ⌘, from opening an empty window before any pane exists — an empty
/// settings window reads as a broken build, which is exactly the report milestone 2 got for the
/// single-tab detail pane.
struct SettingsSceneView: View {
    @Environment(AppModel.self) private var app
    @State private var selection = "general"

    var body: some View {
        Group {
            switch SettingsPaneRegistry.resolution {
            case .placeholder:
                VStack(spacing: 8) {
                    Text(verbatim: L.t("native_settings_placeholder_title"))
                        .font(.headline)
                    Text(verbatim: L.t("native_settings_placeholder_body"))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(32)
                .accessibilityIdentifier("settings-placeholder")
            case .panes:
                TabView(selection: $selection) {
                    ForEach(SettingsPaneRegistry.panes, id: \.id) { pane in
                        pane.makeView(app: app)
                            .tabItem {
                                Label { Text(pane.title) } icon: { Image(systemName: pane.systemImage) }
                            }
                            .tag(pane.id)
                    }
                }
                .accessibilityIdentifier("settings-panes")
            }
        }
        .onAppear { applyRequestedPane() }
        .onChange(of: SettingsPresentation.shared.openSettingsRequest) { applyRequestedPane() }
        .frame(minWidth: 520, minHeight: 360)
    }
    private func applyRequestedPane() {
        guard let id = SettingsPresentation.shared.requestedPane,
              SettingsPaneRegistry.panes.contains(where: { $0.id == id }) else { return }
        selection = id
        SettingsPresentation.shared.requestedPane = nil
    }
}
