import AppKit
import Observation
import ShepherdKit
import SwiftUI
import os

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
                // Not `NoticeBar`: it always draws a close (×) button, and this notice has no
                // state for a dismiss to clear — it is derived from `model.authorization` and
                // reappears the moment macOS is asked again. A dead close button is worse than
                // none, so this renders the same warning without one.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    Text(verbatim: note)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12))
                .accessibilityIdentifier("notify-permission-denied")
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
    /// Tests only: whether the panel is currently hosted. Never read by the app itself — `show`
    /// and `watchActivation` are the only callers that need to know.
    static var isOpen: Bool { controller != nil }
    /// The item and separator `installMenuItem` inserted, so `reset()` can remove exactly those
    /// two — by reference, not by index, since the menu may have grown or shrunk around them by
    /// the time `reset()` runs.
    private static var installedMenuItem: NSMenuItem?
    private static var installedSeparator: NSMenuItem?
    /// Watches for the profile switch that would otherwise leave an open panel bound to a
    /// torn-down model. See `watchActivation(of:generation:)`.
    private static var activationWatcher: Task<Void, Never>?
    /// How many watcher tasks are currently parked on their observation. Tests only — it is the
    /// only externally visible evidence that a cancelled watcher really let go of its
    /// `AppModel` rather than staying suspended forever.
    private(set) static var armedWatchers = 0

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
        let separator = NSMenuItem.separator()
        appMenu.insertItem(item, at: min(1, appMenu.items.count))
        appMenu.insertItem(separator, at: min(2, appMenu.items.count))
        installedMenuItem = item
        installedSeparator = separator
    }

    static func show(_ app: AppModel) {
        // Read synchronously, at the top, and carried to the watcher below: it is the generation
        // this panel is being built for, and every later comparison has to be against that value
        // rather than against whatever the generation happens to be by the time a task runs.
        let generation = app.activationGeneration
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
        } else {
            let hosting = NSHostingController(rootView: view)
            let window = NSWindow(contentViewController: hosting)
            window.title = L.t("native_notify_settings_title")
            window.styleMask = [.titled, .closable]
            let created = NSWindowController(window: window)
            controller = created
            created.showWindow(nil)
            window.makeKeyAndOrderFront(nil)
        }
        // Opening the panel is the other moment the operator's macOS permission may have moved
        // since this process last looked: the denied note they are about to read is what sends
        // them to System Settings, and the note has to disappear when they come back to it.
        // A read, never a prompt — `authorization()` only reports the status.
        Task { await model.refreshAuthorization() }
        // Re-hosting above only helps the *next* call to `show(_:)` — it does nothing for a
        // panel the operator leaves open while switching profiles from the main window. Arm a
        // watcher for that case every time the panel is (re-)shown.
        watchActivation(of: app, generation: generation)
    }

    /// Closes the panel the instant the active profile changes underneath it, so the operator
    /// can never toggle a switch, or read a profile name, that no longer belongs to the front
    /// activation. Closing rather than re-hosting: it needs no logic to decide which of two live
    /// models is "current," and it is the only correct answer when the new activation has no
    /// `NotificationsModel` at all yet (no store, or one still starting up).
    ///
    /// Mirrors `AppModel.watchConnection`'s `withObservationTracking` idiom: `onChange` fires
    /// exactly once, off the main actor, so the continuation hops back before touching AppKit
    /// state. One firing is all this needs — the panel is gone the moment it fires.
    ///
    /// The wait is cancellation-aware, which is not a nicety: `onChange` fires **at most once,
    /// ever**, so a watcher whose generation never changes again has exactly one thing that can
    /// resume it. Cancelling the task does not, by itself — a plain `withCheckedContinuation`
    /// stays suspended, holding this `AppModel`, for the life of the process. The panel arms a
    /// watcher on every `show(_:)`, so that is one stranded task and one retained model per
    /// reopen, and `reset()` could not release an armed one at all. `withTaskCancellationHandler`
    /// turns `cancel()` — which both `show(_:)` and `reset()` already call — into the second
    /// resumption path.
    private static func watchActivation(of app: AppModel, generation: Int) {
        activationWatcher?.cancel()
        activationWatcher = Task { @MainActor in
            // Before waiting on anything. The task body does not run until the main actor gets
            // back to it, and a profile switch can land in that gap — `AppModel.activate` and
            // `teardown` both bump the generation synchronously. `withObservationTracking` would
            // then register against the *new* value and go on waiting for the change after it,
            // leaving the panel open on the outgoing profile's name and toggles.
            guard !Task.isCancelled else { return }
            guard app.activationGeneration == generation else { return closePanel() }
            armedWatchers += 1
            defer { armedWatchers -= 1 }
            let wake = OneShotResume()
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    // Handed over before observation is armed, so a cancellation that has
                    // already fired resumes it here instead of being dropped on the floor.
                    wake.attach(continuation)
                    withObservationTracking {
                        _ = app.activationGeneration
                    } onChange: {
                        wake.fire()
                    }
                }
            } onCancel: {
                wake.fire()
            }
            guard !Task.isCancelled, app.activationGeneration != generation else { return }
            closePanel()
        }
    }

    /// A continuation that exactly one of its two callers gets to resume: the observation's
    /// `onChange` or the task-cancellation handler, whichever arrives first. Both can run off
    /// the main actor and either can arrive before the continuation exists, so the handover and
    /// the resume share one lock. Resuming twice traps; never resuming leaks the task.
    private final class OneShotResume: Sendable {
        private struct State {
            var continuation: CheckedContinuation<Void, Never>?
            var resumed = false
        }

        private let state = OSAllocatedUnfairLock(initialState: State())

        /// Called once, from inside `withCheckedContinuation`. Resumes immediately if a racing
        /// `fire()` already claimed this wait.
        func attach(_ continuation: CheckedContinuation<Void, Never>) {
            let resumeNow = state.withLock { (state: inout State) -> Bool in
                guard !state.resumed else { return true }
                state.continuation = continuation
                return false
            }
            if resumeNow { continuation.resume() }
        }

        /// Resumes the wait, or records that it is over if the continuation has not arrived yet.
        /// A second call is a no-op.
        func fire() {
            let continuation = state.withLock {
                (state: inout State) -> CheckedContinuation<Void, Never>? in
                guard !state.resumed else { return nil }
                state.resumed = true
                defer { state.continuation = nil }
                return state.continuation
            }
            continuation?.resume()
        }
    }

    private static func closePanel() {
        controller?.close()
        controller = nil
    }

    /// Tests and previews only.
    ///
    /// The `cancel()` below really does release an armed watcher now that the wait handles
    /// cancellation — the task wakes, sees `Task.isCancelled` and returns, dropping its
    /// `AppModel`. It wakes on the main actor, so a caller that wants to see `armedWatchers`
    /// back at zero has to yield once.
    static func reset() {
        activationWatcher?.cancel()
        activationWatcher = nil
        menuItemInstalled = false
        if let item = installedMenuItem, let menu = item.menu {
            menu.removeItem(item)
        }
        if let separator = installedSeparator, let menu = separator.menu {
            menu.removeItem(separator)
        }
        installedMenuItem = nil
        installedSeparator = nil
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
