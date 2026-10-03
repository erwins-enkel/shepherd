import AppKit
import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// The repo picker as a real pop-up menu. A SwiftUI `Menu` cannot be opened from ⌥R; an
/// `NSMenu` can. Same outline as iOS: recently used repos, then every repo in a submenu.
@MainActor enum RepoMenu {
    static func make(recent: [Repo], all: [Repo], selected: String, age: (Repo) -> String?,
                     pick: @escaping @MainActor (String) -> Void) -> NSMenu {
        let menu = NSMenu()
        guard !recent.isEmpty else {
            for repo in all { menu.addItem(item(repo, selected: selected, subtitle: nil, pick: pick)) }
            return menu
        }
        menu.addItem(.sectionHeader(title: L.t("native_compose_repo_recent")))
        for repo in recent { menu.addItem(item(repo, selected: selected, subtitle: age(repo), pick: pick)) }
        menu.addItem(.separator())
        let submenu = NSMenu()
        for repo in all { submenu.addItem(item(repo, selected: selected, subtitle: nil, pick: pick)) }
        let everything = NSMenuItem(title: L.t("native_compose_repo_all"), action: nil, keyEquivalent: "")
        everything.submenu = submenu
        menu.addItem(everything)
        return menu
    }

    private static func item(_ repo: Repo, selected: String, subtitle: String?,
                             pick: @escaping @MainActor (String) -> Void) -> NSMenuItem {
        let action = RepoMenuAction { pick(repo.path) }
        let item = NSMenuItem(title: repo.name, action: #selector(RepoMenuAction.fire), keyEquivalent: "")
        item.target = action
        item.representedObject = action
        item.state = repo.path == selected ? .on : .off
        item.subtitle = subtitle
        return item
    }
}

/// `NSMenuItem.target` is weak; the item keeps its action alive through `representedObject`.
@MainActor final class RepoMenuAction: NSObject {
    private let run: @MainActor () -> Void
    init(_ run: @escaping @MainActor () -> Void) { self.run = run }
    @objc func fire() { run() }
}

/// Pops `menu()` up below its own frame whenever `presented` turns true, then reports the close.
struct RepoMenuAnchor: NSViewRepresentable {
    let presented: Bool
    let menu: @MainActor () -> NSMenu
    let closed: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        let coordinator = context.coordinator
        guard presented, !coordinator.showing else { return }
        coordinator.showing = true
        let popup = menu(), done = closed
        // Leave SwiftUI's update pass first: popUp tracks the menu modally until it closes.
        Task { @MainActor in
            if view.window != nil {
                let below = view.isFlipped ? view.bounds.maxY + 4 : view.bounds.minY - 4
                popup.popUp(positioning: nil, at: NSPoint(x: 0, y: below), in: view)
            }
            coordinator.showing = false
            done()
        }
    }

    @MainActor final class Coordinator { var showing = false }
}
