import SwiftUI
import ShepherdKit

@MainActor enum SettingsCommandSearch {
    static func rows(query: String, app: AppModel) -> [MenuCommand] {
        let words = query.folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)
            .split(whereSeparator: { $0.isWhitespace })
        return MenuCommand.Menu.allCases.flatMap { CommandRegistry.commands(in:$0) }
            .filter { command in
                let title = L.t(command.titleKey).folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)
                return words.allSatisfy { title.contains($0) }
            }
    }
}
struct SettingsCommandPalette: View {
    let app: AppModel
    @State private var query = ""
    @State private var selection: String?
    @FocusState private var searchFocused: Bool
    private var rows: [MenuCommand] { SettingsCommandSearch.rows(query:query,app:app) }
    var body: some View {
        VStack {
            TextField(L.t("native_settings_command_search"),text:$query)
                .focused($searchFocused).onSubmit { invoke() }
            List(selection:$selection) {
                ForEach(rows) { command in
                    Button { invoke(command.id) } label: {
                        HStack {
                            Text(L.t(command.titleKey)); Spacer()
                            if let shortcut = command.shortcut {
                                Text(verbatim:"⌘" + (shortcut.option ? "⌥" : "") + (shortcut.shift ? "⇧" : "") + String(shortcut.key).uppercased())
                            }
                        }
                    }.disabled(!command.isEnabled(app)).tag(command.id)
                }
            }
            if rows.isEmpty { Text(L.t("native_settings_no_commands")) }
        }.padding().onAppear { searchFocused = true; selection = rows.first?.id }
        .onChange(of:query) { selection = rows.first?.id }
        .onExitCommand { SettingsPresentation.shared.palette = false }
        .onMoveCommand { direction in
            guard !rows.isEmpty else {return}
            let index = rows.firstIndex(where:{$0.id == selection}) ?? 0
            if direction == .down {selection = rows[min(rows.count-1,index+1)].id}
            if direction == .up {selection = rows[max(0,index-1)].id}
        }.accessibilityIdentifier("settings-command-palette")
    }
    private func invoke(_ id: String? = nil) {
        guard let command = rows.first(where:{$0.id == (id ?? selection)}), command.isEnabled(app) else {return}
        SettingsPresentation.shared.palette = false
        command.action(app)
    }
}
