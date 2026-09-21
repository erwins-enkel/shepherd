import SwiftUI

/// A menu-bar command a stream contributes.
///
/// A value, not a view: the registry is read while `ShepherdApp.body` is evaluated, and a stream
/// that wanted to hand over a `View` would have to reach the model from outside the environment.
/// `action` and `isEnabled` take the `AppModel` explicitly instead, so the command is testable
/// without hosting anything.
///
/// `Sendable` is free — every stored member is either a value or a `@MainActor` closure over one.
@MainActor
public struct MenuCommand: Identifiable, Sendable {
    /// Which top-level menu the item lands in. SwiftUI's `CommandGroup` placements are fixed, so
    /// this enum is the whole vocabulary: a stream picks one of five rather than naming a
    /// `CommandGroupPlacement`, which would let two streams disagree about where "Session" is.
    public enum Menu: String, CaseIterable, Sendable {
        case file, view, session, window, help
    }

    /// Registry key. Unique per process; the last registration for an id wins.
    public let id: String
    let menu: Menu
    /// Ascending sort key within the menu; ties break on `id`, so the order never depends on
    /// dictionary iteration.
    let order: Int
    /// Read through `L.t(_:)` at render time, never stored, so a language change needs no
    /// re-registration. A `StaticString` because every catalog key in this app is a literal.
    public let titleKey: StaticString
    /// `nil` for no shortcut. Spelled as a key equivalent plus modifiers rather than a
    /// `KeyboardShortcut` so two commands' shortcuts can be compared in a test.
    public let shortcut: Shortcut?
    /// Whether the item is selectable right now. Defaults to always.
    public let isEnabled: @MainActor (AppModel) -> Bool
    public let action: @MainActor (AppModel) -> Void

    public struct Shortcut: Equatable, Sendable {
        public let key: Character
        public let shift: Bool
        public let option: Bool

        public init(_ key: Character, shift: Bool = false, option: Bool = false) {
            self.key = key
            self.shift = shift
            self.option = option
        }

        /// Command is implied — every menu shortcut in this app carries it.
        public var eventModifiers: EventModifiers {
            var modifiers: EventModifiers = [.command]
            if shift { modifiers.insert(.shift) }
            if option { modifiers.insert(.option) }
            return modifiers
        }
    }

    public init(
        id: String, menu: Menu, order: Int, titleKey: StaticString,
        shortcut: Shortcut? = nil,
        isEnabled: @escaping @MainActor (AppModel) -> Bool = { _ in true },
        action: @escaping @MainActor (AppModel) -> Void
    ) {
        self.id = id
        self.menu = menu
        self.order = order
        self.titleKey = titleKey
        self.shortcut = shortcut
        self.isEnabled = isEnabled
        self.action = action
    }
}

/// Where streams hang their menu commands.
///
/// Per-process main-actor state, exactly like `DetailTabRegistry`: registration happens once at
/// launch — from `StreamRegistrations.installScene()`, called by `ShepherdApp.init()` — and every
/// read is a SwiftUI body evaluation. It is deliberately NOT `@Observable`: a registry mutated
/// after the scene was built would not refresh the menu anyway, so the fix is to register early,
/// not to make the read reactive and pretend late registration works.
@MainActor
public enum CommandRegistry {
    private static var registered: [String: MenuCommand] = [:]

    /// Idempotent per id — the last registration wins, so the integration lane can replace a
    /// command without a removal API.
    public static func register(_ command: MenuCommand) { registered[command.id] = command }

    /// This menu's commands, ordered by `order` then `id`.
    public static func commands(in menu: MenuCommand.Menu) -> [MenuCommand] {
        registered.values
            .filter { $0.menu == menu }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}
