import SwiftUI
import ShepherdKit

@MainActor public enum SettingsCommandSearch {
    public static func rows(query: String, app: AppModel) -> [MenuCommand] {
        let words = query.folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)
            .split(whereSeparator: { $0.isWhitespace })
        return MenuCommand.Menu.allCases.flatMap { CommandRegistry.commands(in:$0) }
            .filter { command in
                let title = L.t(command.titleKey).folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)
                return words.allSatisfy { title.contains($0) }
            }
    }
}
