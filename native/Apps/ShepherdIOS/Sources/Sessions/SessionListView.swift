import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionListView: View {
    let model: SidebarModel
    let select: (String) -> Void
    @Environment(AppModel.self) private var app
    var body: some View {
        List {
            if model.showsRepoRail(model.chips) {
                Section {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(model.chips, id: \.path) { chip in
                                Button { model.toggleRepo(chip.path, additive: false) } label: {
                                    Text(verbatim: URL(fileURLWithPath: chip.path).lastPathComponent)
                                }
                                .buttonStyle(.bordered)
                                .tint(model.activeRepos.contains(chip.path) ? .accentColor : .secondary)
                            }
                        }
                    }
                }
            }
            ForEach(model.sessions, id: \.id) { raw in
                let session = model.rendered(raw)
                Button { select(session.id) } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(verbatim: session.desig).font(.caption.monospaced()).foregroundStyle(.secondary)
                        Text(verbatim: session.name).font(.headline).foregroundStyle(.primary)
                        Text(verbatim: SessionStatusStyle.label(session.status))
                            .font(.caption).foregroundStyle(SessionStatusStyle.tint(session.status))
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                }.accessibilityIdentifier("session-row-\(session.id)")
            }
        }
        .overlay {
            if model.sessions.isEmpty, app.store?.connection == .live {
                ContentUnavailableView(L.t("native_sidebar_empty"), systemImage: "tray")
            }
        }
        .navigationTitle(L.t("native_sidebar_title"))
        .accessibilityIdentifier("session-list")
        .onChange(of: model.sessions.map(\.id)) { _, ids in app.reconcileSelection(against: ids) }
    }
}
