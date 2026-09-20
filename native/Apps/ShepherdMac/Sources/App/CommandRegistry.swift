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
struct MenuCommand: Identifiable, Sendable {
    /// Which top-level menu the item lands in. SwiftUI's `CommandGroup` placements are fixed, so
    /// this enum is the whole vocabulary: a stream picks one of five rather than naming a
    /// `CommandGroupPlacement`, which would let two streams disagree about where "Session" is.
    enum Menu: String, CaseIterable, Sendable {
        case file, view, session, window, help
    }

    /// Registry key. Unique per process; the last registration for an id wins.
    let id: String
    let menu: Menu
    /// Ascending sort key within the menu; ties break on `id`, so the order never depends on
    /// dictionary iteration.
    let order: Int
    /// Read through `L.t(_:)` at render time, never stored, so a language change needs no
    /// re-registration. A `StaticString` because every catalog key in this app is a literal.
    let titleKey: StaticString
    /// `nil` for no shortcut. Spelled as a key equivalent plus modifiers rather than a
    /// `KeyboardShortcut` so two commands' shortcuts can be compared in a test.
    let shortcut: Shortcut?
    /// Whether the item is selectable right now. Defaults to always.
    let isEnabled: @MainActor (AppModel) -> Bool
    let action: @MainActor (AppModel) -> Void

    struct Shortcut: Equatable, Sendable {
        let key: Character
        let shift: Bool
        let option: Bool

        init(_ key: Character, shift: Bool = false, option: Bool = false) {
            self.key = key
            self.shift = shift
            self.option = option
        }

        /// Command is implied — every menu shortcut in this app carries it.
        var eventModifiers: EventModifiers {
            var modifiers: EventModifiers = [.command]
            if shift { modifiers.insert(.shift) }
            if option { modifiers.insert(.option) }
            return modifiers
        }
    }

    init(
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
enum CommandRegistry {
    private static var registered: [String: MenuCommand] = [:]

    /// Idempotent per id — the last registration wins, so the integration lane can replace a
    /// command without a removal API.
    static func register(_ command: MenuCommand) { registered[command.id] = command }

    /// This menu's commands, ordered by `order` then `id`.
    static func commands(in menu: MenuCommand.Menu) -> [MenuCommand] {
        registered.values
            .filter { $0.menu == menu }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}

/// Renders one menu's commands. Pulled out of `ShepherdApp` so the `.commands { }` builder stays a
/// list of five identical lines and a stream never has to touch it.
struct MenuCommandItems: View {
    let menu: MenuCommand.Menu
    /// Passed in, **not** read from `@Environment`. A `Scene`'s `.commands { }` builder is not
    /// inside the `WindowGroup`'s content, so `.environment(model)` applied to `RootView` never
    /// reaches it and `@Environment(AppModel.self)` would trap at the first menu render. The model
    /// is in hand at `ShepherdApp.body` anyway, so handing it over is both simpler and checkable.
    let app: AppModel

    var body: some View {
        ForEach(CommandRegistry.commands(in: menu)) { command in
            Button(L.t(command.titleKey)) { command.action(app) }
                .disabled(!command.isEnabled(app))
                .modifier(OptionalShortcut(shortcut: command.shortcut))
        }
    }
}

/// `.keyboardShortcut` has no "none" argument, so the choice is a modifier rather than a ternary
/// inside the button body — a ternary there would need both branches to be the same `View` type.
private struct OptionalShortcut: ViewModifier {
    let shortcut: MenuCommand.Shortcut?

    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(
                KeyEquivalent(shortcut.key), modifiers: shortcut.eventModifiers)
        } else {
            content
        }
    }
}
