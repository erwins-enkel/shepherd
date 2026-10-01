import SwiftUI
import ShepherdAppCore

/// D10/D11: phones keep the three live lenses in the thumb zone; panel lenses
/// remain reachable in the gear menu. Touch-wide layouts retain the full top strip.
struct IOSSessionListLayout: Equatable {
    let bottomBar: Bool
    var stripLenses: [HerdLens] { bottomBar ? [.next, .all, .ready] : HerdLens.allCases }
    var menuLenses: [HerdLens] { bottomBar ? [.done, .owed] : [] }
    var repoRail: Bool { !bottomBar }

    init(sizeClass: UserInterfaceSizeClass?) { bottomBar = sizeClass != .regular }
}

struct SessionLensButton: View {
    let lens: HerdLens
    let selected: Bool
    let bottom: Bool
    let owedCount: String
    let owedAccessibilityValue: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Text(verbatim: lens.glyph).accessibilityHidden(true)
                HStack(spacing: 3) {
                    Text(verbatim: L.t(lens.labelKey))
                        .fixedSize(horizontal: false, vertical: true)
                    if lens == .owed {
                        Text(verbatim: owedCount).monospacedDigit()
                            .padding(.horizontal, 3)
                            .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.amber, lineWidth: 0.5) }
                            .accessibilityIdentifier("herd-owed-count")
                    }
                }
            }
            .sessionFont(label: true, weight: .medium)
            .foregroundStyle(selected ? SessionListStyle.amber : SessionListStyle.muted)
            .padding(.horizontal, bottom ? 4 : 10).padding(.vertical, 8)
            .frame(minWidth: 44, maxWidth: bottom ? .infinity : nil, minHeight: 48)
            .background(selected ? SessionListStyle.selected : .clear)
            .overlay(alignment: bottom ? .top : .bottom) {
                Rectangle().fill(selected ? SessionListStyle.amber : SessionListStyle.line)
                    .frame(height: selected ? 2 : 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: L.t(lens.labelKey)))
        .accessibilityValue(lens == .owed ? owedAccessibilityValue : "")
        .accessibilityHint(Text(verbatim: L.t(lens.titleKey)))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("herd-lens-\(lens.rawValue)")
    }
}

struct SessionReposSheet: View {
    let model: SidebarModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button {
                    model.selectedRepos = []
                    dismiss()
                } label: {
                    repoLabel(L.t("herd_seg_all"), count: model.chips.reduce(0) { $0 + $1.count }, selected: model.activeRepos.isEmpty)
                }
                .accessibilityAddTraits(model.activeRepos.isEmpty ? .isSelected : [])
                .accessibilityIdentifier("repo-filter-all")
                ForEach(model.chips) { chip in
                    let selected = model.activeRepos.contains(chip.path)
                    Button {
                        model.toggleRepo(chip.path, additive: false)
                        dismiss()
                    } label: { repoLabel(chip.name, count: chip.count, selected: selected) }
                    .accessibilityLabel(Text(verbatim: selected ? L.t("repo_filter_active_aria", chip.name) : L.t("repo_filter_apply_aria", chip.name)))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("repo-filter-\(chip.name)")
                }
            }
            .scrollContentBackground(.hidden)
            .background(SessionListStyle.background)
            .navigationTitle(L.t("repo_switcher_label"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L.t("common_close")) { dismiss() }
                }
            }
        }
        .tint(SessionListStyle.amber)
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("session-repos-sheet")
    }

    private func repoLabel(_ name: String, count: Int, selected: Bool) -> some View {
        HStack {
            Text(verbatim: name)
            Spacer()
            Text(verbatim: String(count)).monospacedDigit()
            if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
        }
        .sessionFont()
        .foregroundStyle(selected ? SessionListStyle.amber : SessionListStyle.ink)
        .frame(minHeight: 44)
    }
}
