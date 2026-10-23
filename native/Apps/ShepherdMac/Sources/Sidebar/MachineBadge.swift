import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// The machine a mirrored session runs on (#2768); nothing for a local session. Identity, not
/// state: slate like the other informational segments, with the amber ⚠ of a standing condition
/// while the machine is unreachable. Hover names the machine; a click opens the explanation of
/// where the session runs, the state of the link and why its actions are not offered here.
struct MachineBadge: View {
    let session: Session
    let now: Int
    @State private var explaining = false

    var body: some View {
        if let host = session.host, let connection = session.connection {
            let offline = RemoteSessionCopy.isDisconnected(connection)
            Button { explaining = true } label: {
                HStack(spacing: 4) {
                    if offline {
                        Text(verbatim: "⚠").foregroundStyle(ShepherdPalette.amber)
                    }
                    Text(verbatim: host.name).lineLimit(1)
                }
                .modifier(ShepherdMonoFont(label: true, weight: .semibold))
                .foregroundStyle(ShepherdPalette.slate)
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help(L.t("remote_runs_on", host.name))
            .accessibilityLabel(L.t("remote_runs_on", host.name))
            .accessibilityIdentifier("machine-badge-\(session.id)")
            .popover(isPresented: $explaining) {
                RemoteExplanationView(
                    explanation: RemoteSessionCopy.explanation(host: host, connection: connection, now: now, actionsHere: true))
            }
        }
    }
}

/// A descriptive title, a short summary and labelled sections with one idea each.
struct RemoteExplanationView: View {
    let explanation: RemoteExplanation

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: explanation.title).font(.headline)
            Text(verbatim: explanation.summary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(explanation.sections) { section in
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: section.label).font(.callout.weight(.semibold))
                    Text(verbatim: section.text).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(.callout)
        .padding(16)
        .frame(width: 340, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("remote-explanation")
    }
}
