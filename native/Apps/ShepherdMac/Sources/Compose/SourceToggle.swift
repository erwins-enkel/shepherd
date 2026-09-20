import SwiftUI

struct SourceToggle: View {
    enum Source: Hashable { case issues, commands }
    @Binding var selection: Source

    var body: some View {
        Picker(L.t("promptsources_title"), selection: $selection) {
            Text(verbatim: L.t("promptsources_issues_tab")).tag(Source.issues)
            Text(verbatim: L.t("promptsources_commands_tab")).tag(Source.commands)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .accessibilityIdentifier("compose.source")
    }
}
