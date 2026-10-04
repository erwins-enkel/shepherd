import SwiftUI
import ShepherdAppCore

struct IOSServerHint: View {
    let name: String
    var body: some View {
        Text(verbatim: name).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            .lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.line, lineWidth: 0.5) }
            .accessibilityLabel(Text(verbatim: L.t("native_ios_server_hint", name)))
            .accessibilityIdentifier("session-server-hint")
    }
}

struct IOSServerReposSheet: View {
    let model: SidebarModel
    @Environment(IOSServerHub.self) private var hub: IOSServerHub?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        if let hub {
            let snapshot = IOSMergedSessionPresentation.snapshot(hub)
            NavigationStack {
                List {
                    Button { hub.selectedRepos = []; dismiss() } label: {
                        label(L.t("herd_seg_all"), count: snapshot.chips.reduce(0) { $0 + $1.count }, selected: snapshot.repos.isEmpty)
                    }.accessibilityIdentifier("repo-filter-all")
                    ForEach(snapshot.chips) { chip in
                        Button { hub.toggleRepo(chip.path); dismiss() } label: {
                            label(chip.name, count: chip.count, selected: snapshot.repos.contains(chip.path))
                        }.accessibilityIdentifier("repo-filter-\(chip.name)")
                    }
                }.scrollContentBackground(.hidden).background(SessionListStyle.background)
                    .navigationTitle(L.t("repo_switcher_label"))
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close")) { dismiss() } } }
            }.tint(SessionListStyle.amber).preferredColorScheme(.dark).presentationDetents([.medium, .large])
        } else { SessionReposSheet(model: model) }
    }
    private func label(_ name: String, count: Int, selected: Bool) -> some View {
        HStack {
            Text(verbatim: name); Spacer(); Text(verbatim: String(count)).monospacedDigit()
            if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
        }.sessionFont().frame(minHeight: 44).foregroundStyle(selected ? SessionListStyle.amber : SessionListStyle.ink)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
