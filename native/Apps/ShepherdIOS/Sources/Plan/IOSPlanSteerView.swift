import SwiftUI
import ShepherdAppCore

struct IOSPlanSteerView: View {
    @Bindable var model: IOSPlanSteer
    var fixture = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: L.t("plangate_menu_editor_label")).sessionFont(weight: .semibold)
            if fixture {
                Text(verbatim: model.draft).padding(12).overlay { Rectangle().stroke(SessionListStyle.brightLine) }
            } else {
                TextField(L.t("plangate_menu_editor_label"), text: $model.draft, axis: .vertical)
                    .lineLimit(5...14).padding(12)
                    .background(SessionListStyle.background)
                    .overlay { Rectangle().stroke(SessionListStyle.brightLine) }
                    .disabled(model.submitting || model.sent)
                    .accessibilityIdentifier("plan-steer-draft")
            }
            if let key = model.outcome { Text(verbatim: L.t(key)).accessibilityIdentifier("plan-steer-outcome") }
            Button { Task { await model.send() } } label: {
                HStack {
                    if model.submitting {
                        if fixture { Image(systemName: "arrow.triangle.2.circlepath") }
                        else { ProgressView() }
                    }
                    Text(verbatim: L.t(model.submitting ? "common_loading" : "plangate_menu_editor_send"))
                }
            }.disabled(!model.canSend).accessibilityIdentifier("plan-steer-send")
        }.sessionFont().foregroundStyle(SessionListStyle.ink)
    }
}
