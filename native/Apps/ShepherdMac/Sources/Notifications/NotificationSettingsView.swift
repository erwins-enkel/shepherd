import AppKit
import ShepherdKit
import SwiftUI

/// The per-profile notification switches.
///
/// The two pure helpers exist so the panel's three permission states are assertable without
/// hosting SwiftUI — the same reason `SidebarSlot.Resolution` and `DetailTabRegistry.Layout` are
/// named rather than decided inline.
struct NotificationSettingsView: View {
    let model: NotificationsModel
    let profileName: String

    /// `nil` unless macOS has actually refused; "not yet asked" is a button, not a warning.
    static func permissionNote(for authorization: NotificationAuthorization) -> String? {
        authorization == .denied ? L.t("native_notify_settings_permission_denied") : nil
    }

    static func showsAskButton(for authorization: NotificationAuthorization) -> Bool {
        authorization == .notDetermined
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("native_notify_settings_title")).font(.headline)
            Text(verbatim: L.t("native_notify_settings_scope", profileName))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let note = Self.permissionNote(for: model.authorization) {
                NoticeBar(message: note) {}
            }
            if Self.showsAskButton(for: model.authorization) {
                Button(L.t("native_notify_settings_permission_ask")) {
                    Task { await model.requestAuthorization() }
                }
                .accessibilityIdentifier("notify-request-permission")
            }

            Toggle(
                L.t("native_notify_settings_enabled"),
                isOn: Binding(
                    get: { model.settings.enabled },
                    set: { model.save(model.settings.settingEnabled($0)) })
            )
            .accessibilityIdentifier("notify-enabled")

            ForEach(NotificationCategory.allCases, id: \.rawValue) { category in
                Toggle(
                    category.label,
                    isOn: Binding(
                        get: { model.settings.isOn(category) },
                        set: { model.save(model.settings.setting(category, to: $0)) })
                )
                .disabled(!model.settings.enabled)
                .padding(.leading, 18)
                .accessibilityIdentifier("notify-category-\(category.rawValue)")
            }

            Text(verbatim: L.t("native_notify_settings_quiet_hint"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(width: 420, alignment: .leading)
        .accessibilityIdentifier("notification-settings")
    }
}

/// A standalone window plus the app-menu item that opens it.
///
/// AppKit rather than a SwiftUI `Settings` scene because a scene lives on `ShepherdApp`, which
/// this stream must not edit. The window is created lazily and reused; closing it releases
/// nothing the model needs.
@MainActor
enum NotificationSettingsWindow {
    private(set) static var menuItemInstalled = false
    private static var controller: NSWindowController?

    /// Adds "Notifications…" to the application menu, once per process. A second call is a no-op,
    /// which matters because `StreamRegistrations.installAll(into:)` may run more than once.
    static func installMenuItem(_ app: AppModel) {
        guard !menuItemInstalled else { return }
        guard let appMenu = NSApp?.mainMenu?.items.first?.submenu else {
            // Under test hosting there is no main menu yet; the panel is still reachable through
            // `show(_:)`, so this is a missing convenience, not a failure. The flag stays *false*
            // so a later call — the launch task runs `installAll(into:)` more than once — still
            // gets its chance once AppKit has built the menu. Setting it before this guard would
            // mark the item installed on a process that never got one.
            Log.app.info("no application menu to add the notifications item to")
            return
        }
        menuItemInstalled = true
        let item = NSMenuItem(
            title: L.t("native_notify_settings_menu_item"),
            action: #selector(MenuTarget.open(_:)), keyEquivalent: "")
        let target = MenuTarget(app: app)
        item.target = target
        item.representedObject = target  // keeps the target alive with the item
        appMenu.insertItem(item, at: min(1, appMenu.items.count))
        appMenu.insertItem(.separator(), at: min(2, appMenu.items.count))
    }

    static func show(_ app: AppModel) {
        guard let model = app.extension(NotificationsModel.self) else {
            Log.app.info("no notifications model yet — connect a server first")
            return
        }
        let name = app.activeProfile?.name ?? "Shepherd"
        let view = NotificationSettingsView(model: model, profileName: name)
        if let controller {
            // Re-host, never merely re-show. `model` is the *current* activation's extension and
            // `name` the current profile; a window kept across a profile switch would otherwise go
            // on displaying — and writing — the previous profile's switches.
            (controller.window?.contentViewController
                as? NSHostingController<NotificationSettingsView>)?.rootView = view
            controller.window?.makeKeyAndOrderFront(nil)
            return
        }
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = L.t("native_notify_settings_title")
        window.styleMask = [.titled, .closable]
        let created = NSWindowController(window: window)
        controller = created
        created.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
    }

    /// Tests and previews only.
    static func reset() {
        menuItemInstalled = false
        controller?.close()
        controller = nil
    }

    /// `NSMenuItem` needs an Objective-C target; this is the smallest one that closes over the
    /// model. `@MainActor` rather than `MainActor.assumeIsolated` inside a nonisolated method:
    /// under Swift 6 strict concurrency, a nonisolated `@objc` method capturing `app` (a
    /// main-actor-isolated `AppModel`) cannot send it across the isolation boundary. Declaring
    /// the whole class `@MainActor` is sound because AppKit only ever invokes a menu item's
    /// action on the main thread.
    @MainActor
    private final class MenuTarget: NSObject {
        private let app: AppModel

        init(app: AppModel) {
            self.app = app
        }

        @objc func open(_ sender: Any?) {
            NotificationSettingsWindow.show(app)
        }
    }
}
