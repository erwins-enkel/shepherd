import AppKit
import SwiftUI
import ShepherdKit

/// The Herd sidebar: lens strip, repo chip rail, then the grouped session list. Installed into
/// `SidebarSlot`, so `MainWindow` renders it without knowing it exists.
struct SidebarView: View {
    @Environment(AppModel.self) private var app
    let model: SidebarModel

    var body: some View {
        @Bindable var app = app

        return VStack(spacing: 0) {
            lensStrip
            // The web shows the rail only once there is something to choose between.
            if model.chips.count >= 2 { repoRail }
            Divider()
            list(selection: $app.selectedSessionID)
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

    private var repoRail: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(model.chips) { chip in
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
    private func list(selection: Binding<String?>) -> some View {
        if model.groups.isEmpty {
            ContentUnavailableView(emptyCopy, systemImage: "tray")
        } else {
            List(selection: selection) {
                ForEach(model.groups) { group in
                    HerdGroupView(
                        group: group,
                        isCollapsed: model.collapsedStages.contains(group.stage),
                        block: { model.block(for: $0) },
                        onToggle: { model.toggleCollapsed(group.stage) })
                }
            }
        }
    }

    /// The web has a distinct empty line per lens, and one for an empty single-repo filter.
    private var emptyCopy: String {
        if model.selectedRepos.count == 1, let repo = model.selectedRepos.first {
            return L.t("herd_repo_filter_empty", (repo as NSString).lastPathComponent)
        }
        switch model.lens {
        case .ready: return L.t("herd_ready_empty")
        case .done: return L.t("herd_done_empty")
        default: return L.t("native_sidebar_empty")
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
