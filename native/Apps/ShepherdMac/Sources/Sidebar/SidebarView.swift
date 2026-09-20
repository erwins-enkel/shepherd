import AppKit
import SwiftUI
import ShepherdKit

/// The Herd sidebar: lens strip, repo chip rail, then the grouped session list. Installed into
/// `SidebarSlot`, so `MainWindow` renders it without knowing it exists.
struct SidebarView: View {
    @Environment(AppModel.self) private var app
    let model: SidebarModel

    var body: some View {
        // Deadlines are display inputs too: a final critic round or merge marker can expire
        // without another server frame. The row's own timeline cannot invalidate its parent
        // partition, so sample the groups and Ready lens here at the same cadence as the row.
        TimelineView(.periodic(from: .now, by: 20)) { _ in
            content
        }
    }

    private var content: some View {
        @Bindable var app = app
        // Read each derived collection once per render: both recompute the whole partition
        // (`HerdPartition.stageOf` per session), and the old code read `model.chips` and
        // `model.groups` twice each — once for a gate/emptiness check, once again to render —
        // doubling the partition pass on every repaint for no reason.
        let chips = model.chips
        let groups = model.groups

        return VStack(spacing: 0) {
            HeaderStrip(model: model)
            lensStrip
            // Shown once there is something to choose between — or whenever a filter is actually
            // applied, so the rail can never be the control that vanishes while its filter stays.
            if model.showsRepoRail(chips) { repoRail(chips) }
            Divider()
            list(groups, selection: $app.selectedSessionID)
        }
        .accessibilityIdentifier("herd-sidebar")
    }

    private var lensStrip: some View {
        HStack(spacing: 0) {
            ForEach(HerdLens.allCases, id: \.self) { lens in
                Button { model.lens = lens } label: {
                    VStack(spacing: 1) {
                        Text(verbatim: lens.glyph).font(.caption)
                        Text(verbatim: L.t(lens.labelKey)).font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .background(model.lens == lens ? Color.orange.opacity(0.16) : .clear)
                }
                .buttonStyle(.plain)
                .disabled(!lens.isAvailable)
                .help(L.t(lens.titleKey))
                .accessibilityIdentifier("herd-lens-\(lens.rawValue)")
            }
        }
        .accessibilityLabel(L.t("herd_lenses_label"))
    }

    private func repoRail(_ chips: [HerdRepoChip]) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    let selected = model.selectedRepos.contains(chip.path)
                    Button {
                        model.toggleRepo(
                            chip.path, additive: NSEvent.modifierFlags.contains(.shift))
                    } label: {
                        HStack(spacing: 4) {
                            Text(verbatim: chip.name).lineLimit(1)
                            Text(verbatim: "\(chip.count)").foregroundStyle(.secondary)
                        }
                        .font(.caption)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(
                            selected
                                ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.10),
                            in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        selected
                            ? L.t("repo_filter_active_aria", chip.name)
                            : L.t("repo_filter_apply_aria", chip.name))
                    .accessibilityIdentifier("repo-chip-\(chip.name)")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .scrollIndicators(.never)
        .accessibilityLabel(L.t("repo_switcher_label"))
    }

    @ViewBuilder
    private func list(_ groups: [HerdGroup], selection: Binding<String?>) -> some View {
        if groups.isEmpty {
            ContentUnavailableView(
                SidebarCopy.empty(lens: model.lens, repos: model.activeRepos),
                systemImage: "tray")
        } else {
            List(selection: selection) {
                ForEach(groups) { group in
                    HerdGroupView(
                        group: group,
                        isCollapsed: model.collapsedStages.contains(group.stage),
                        display: { model.rendered($0) },
                        block: { model.block(for: $0) },
                        onToggle: { model.toggleCollapsed(group.stage) })
                }
            }
        }
    }
}

/// This stream's single registration point, so nothing else here touches app start-up.
///
/// Idempotent: `AppModel.register(_:)` is itself keyed on `ObjectIdentifier(SidebarModel.self)`
/// and a no-op on a second call, and reassigning `SidebarSlot.content` to an equivalent closure is
/// harmless — so calling `run(_:)` twice, which the launch task may do, leaves the app exactly
/// where one call would.
@MainActor
enum SidebarInstall {
    static func run(_ app: AppModel) {
        app.register(SidebarModel.self)
        SidebarSlot.content = { app in
            guard let model = app.extension(SidebarModel.self) else { return AnyView(EmptyView()) }
            return AnyView(SidebarView(model: model))
        }
    }
}
