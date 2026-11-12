import SwiftUI
import ShepherdAppCore
import ShepherdKit

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
    @State private var selectedSettings: IOSRepoSettingsTarget?
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
                        ForEach(IOSRepoSettingsTarget.targets(chip: chip, hub: hub)) { target in
                            HStack {
                                Button { hub.toggleRepo(chip.paths); dismiss() } label: {
                                    VStack(alignment: .leading) {
                                        label(chip.name, count: chip.count, selected: !snapshot.repos.isEmpty && chip.paths.isSuperset(of: snapshot.repos))
                                        IOSRepoSettingsStatus(target: target)
                                    }
                                }.buttonStyle(.borderless).accessibilityIdentifier("repo-filter-\(chip.name)")
                                Button { selectedSettings = target } label: {
                                    Image(systemName: "slider.horizontal.3").frame(minWidth: 44, minHeight: 44)
                                }.buttonStyle(.borderless)
                                    .accessibilityLabel(Text(verbatim: L.t("native_repo_open_settings", target.slug ?? target.name)))
                                    .accessibilityIdentifier("repo-settings-\(target.id)")
                            }
                        }
                    }
                }.scrollContentBackground(.hidden).background(SessionListStyle.background)
                    .navigationDestination(item: $selectedSettings) { target in
                        if let slug = target.slug {
                            IOSRepoSettingsView(model: .init(client: target.client, slug: slug))
                        } else {
                            IOSLocalRepoSettingsView(client: target.client, repo: target.path, name: target.name)
                        }
                    }
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
            .contentShape(Rectangle()).accessibilityAddTraits(selected ? .isSelected : [])
    }
}
