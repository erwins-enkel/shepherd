import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// One connected machine's mirrored sessions (#2768), after the local lifecycle groups: a header
/// naming the machine, its platform and the state of the link, then its rows. Read-only — no
/// menu, no plan badges, no row signals: none of this server's actions apply to them, and the
/// machine badge on each row explains why. Its tasks that are not settled come first (#2776).
/// The web's `HerdMachineGroups.svelte`.
struct HerdMachineGroupView: View {
    @Environment(AppModel.self) private var app
    let group: HerdMachineGroup
    let now: Int

    var body: some View {
        Section {
            if let dispatches = app.extension(RemoteDispatchesModel.self) {
                ForEach(group.dispatches, id: \.id) { dispatch in
                    RemoteDispatchRow(dispatch: dispatch, model: dispatches)
                        .padding(10)
                        .background(ShepherdPalette.panel2, in: RoundedRectangle(cornerRadius: 6))
                        .overlay { RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(ShepherdPalette.line, style: StrokeStyle(lineWidth: 1, dash: [3])) }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 3, leading: 8, bottom: 3, trailing: 8))
                }
            }
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
            HStack(spacing: 10) {
                Text(verbatim: group.host.name)
                    .foregroundStyle(ShepherdPalette.ink)
                Text(verbatim: RemoteSessionCopy.platformName(group.host.platform).uppercased())
                    .tracking(1)
                    .foregroundStyle(ShepherdPalette.slate)
                Spacer(minLength: 0)
                // A machine with only tasks that are not settled has no link state to show.
                if let connection = group.connection {
                    Text(verbatim: RemoteSessionCopy.stateLabel(connection).uppercased())
                        .tracking(1)
                        .foregroundStyle(RemoteSessionCopy.isDisconnected(connection)
                            ? ShepherdPalette.amber : ShepherdPalette.slate)
                }
            }
            .modifier(ShepherdMonoFont(label: true))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel(L.t("remote_group_aria", group.host.name))
            .accessibilityIdentifier("herd-machine-\(group.host.instanceId)")
        }
    }
}
