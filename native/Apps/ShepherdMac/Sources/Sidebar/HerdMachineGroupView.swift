import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// One connected machine's mirrored sessions (#2768), after the local lifecycle groups: a header
/// naming the machine, its platform and the state of the link, then its rows. Read-only — no
/// menu, no plan badges, no row signals: none of this server's actions apply to them, and the
/// machine badge on each row explains why. The web's `HerdMachineGroups.svelte`.
struct HerdMachineGroupView: View {
    @Environment(AppModel.self) private var app
    let group: HerdMachineGroup
    let now: Int

    var body: some View {
        Section {
            ForEach(group.sessions, id: \.id) { session in
                SessionRow(session: session, content: SessionRowContent(session: session, now: now))
                    .modifier(SettingsStatusShape(status: session.status))
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(app.selectedSessionID == session.id ? ShepherdPalette.sel : ShepherdPalette.panel,
                        in: RoundedRectangle(cornerRadius: 6))
                    .overlay { RoundedRectangle(cornerRadius: 6)
                        .stroke(app.selectedSessionID == session.id ? ShepherdPalette.lineBright : ShepherdPalette.line,
                            lineWidth: 1) }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
                    .tag(session.id)
            }
        } header: {
            let offline = RemoteSessionCopy.isDisconnected(group.connection)
            HStack(spacing: 10) {
                Text(verbatim: group.host.name)
                    .foregroundStyle(ShepherdPalette.ink)
                Text(verbatim: RemoteSessionCopy.platformName(group.host.platform).uppercased())
                    .tracking(1)
                    .foregroundStyle(ShepherdPalette.slate)
                Spacer(minLength: 0)
                Text(verbatim: RemoteSessionCopy.stateLabel(group.connection).uppercased())
                    .tracking(1)
                    .foregroundStyle(offline ? ShepherdPalette.amber : ShepherdPalette.slate)
            }
            .modifier(ShepherdMonoFont(label: true))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel(L.t("remote_group_aria", group.host.name))
            .accessibilityIdentifier("herd-machine-\(group.host.instanceId)")
        }
    }
}
