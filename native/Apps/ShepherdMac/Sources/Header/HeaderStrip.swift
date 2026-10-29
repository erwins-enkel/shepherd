import ShepherdAppCore
import SwiftUI

/// The band above the lens strip: what the herd is doing, and how much budget is left.
struct HeaderStrip: View {
    let model: SidebarModel
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HerdTalliesView(tallies: model.tallies)
            UsageMeterView(limits: model.limits)
            if let store = app.store {
                HostStatusButton(store: store).id(ObjectIdentifier(store))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("herd-header")
    }
}
