import ShepherdAppCore
import SwiftUI

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
