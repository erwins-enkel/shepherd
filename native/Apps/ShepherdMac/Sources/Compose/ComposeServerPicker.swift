import AppKit
import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ComposeServerPicker: View {
    let app: AppModel
    let prompt: String
    @Binding var presented: Bool

    private var connected: Bool { app.store?.connection == .live }
    var body: some View {
        Button { presented = true } label: {
            HStack(spacing: 7) {
                Circle().fill(connected ? Color.green : Color.secondary).frame(width: 7, height: 7)
                Text(verbatim: app.activeProfile?.name ?? L.t("native_toolbar_servers"))
                Image(systemName: "chevron.down")
            }
        }
        .accessibilityLabel(L.t("native_toolbar_servers"))
        .accessibilityIdentifier("compose.server")
        .background(RepoMenuAnchor(presented: presented, menu: menu, closed: { presented = false }))
    }

    private func menu() -> NSMenu {
        let menu = NSMenu()
        for profile in app.profiles {
            let action = RepoMenuAction {
                Task { await app.activateForCompose(profile, prompt: prompt) }
            }
            let item = NSMenuItem(title: profile.name, action: #selector(RepoMenuAction.fire), keyEquivalent: "")
            item.target = action; item.representedObject = action
            item.state = profile.id == app.activeProfile?.id ? .on : .off
            menu.addItem(item)
        }
        return menu
    }
}
