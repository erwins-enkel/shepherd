import Observation
import UIKit
import ShepherdAppCore

/// The app icon's long-press menu. Info.plist declares the items statically, so they show
/// before the first launch; the raw values are their `UIApplicationShortcutItemType`s.
enum IOSQuickAction: String, CaseIterable {
    case dictateTask = "run.shepherd.quick-action.dictate-task"
    case newTask = "run.shepherd.quick-action.new-task"
}

/// Holds a chosen quick action until a server can show the composer: on a cold launch it
/// arrives before any store exists. A dictation request then waits for the composer to start it.
@MainActor
@Observable
final class IOSQuickActions {
    static let shared = IOSQuickActions()

    private(set) var pending: IOSQuickAction?
    private(set) var dictationRequested = false

    @discardableResult
    func receive(type: String) -> Bool {
        guard let action = IOSQuickAction(rawValue: type) else { return false }
        pending = action
        return true
    }

    /// Opens the composer once a server can host it; an already open composer is reused.
    func route(_ hub: IOSServerHub) {
        guard let action = pending else { return }
        // Nothing to compose on: the app opens on the server list instead.
        if hub.connectedIDs.isEmpty { pending = nil; return }
        guard hub.routedSheet?.sheet == .newSession || hub.openComposer() else { return }
        pending = nil
        dictationRequested = action == .dictateTask
    }

    /// True once per request, and only while the composer can start recording.
    func consumeDictation(eligible: Bool) -> Bool {
        guard eligible, dictationRequested else { return false }
        dictationRequested = false
        return true
    }

    /// A request left behind when the app leaves the foreground must not fire on a later return.
    func reset() {
        pending = nil
        dictationRequested = false
    }
}

/// SwiftUI has no quick-action callback, so this forwards the warm-launch one. It implements
/// nothing else: SwiftUI keeps handling URLs and scene phases.
@MainActor
final class IOSSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem) async -> Bool {
        IOSQuickActions.shared.receive(type: shortcutItem.type)
    }
}
