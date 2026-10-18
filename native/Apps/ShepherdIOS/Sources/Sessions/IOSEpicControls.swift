import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSEpicActionButton: View {
    let title: String
    var icon: String = ""
    var tint: Color = SessionListStyle.amber
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if !icon.isEmpty { Image(systemName: icon) }
                Text(verbatim: title)
            }.sessionFont(label: true, weight: .medium)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 10).contentShape(Rectangle())
                .overlay { RoundedRectangle(cornerRadius: 2).stroke(tint.opacity(0.65), lineWidth: 1) }
        }.buttonStyle(.plain).foregroundStyle(tint)
    }
}

struct IOSEpicConfirmation: ViewModifier {
    let control: IOSEpicControl
    var enabled = true
    func body(content: Content) -> some View {
        content.confirmationDialog(L.t("epic_supersede_title", String(control.group.parentNumber)),
            isPresented: Binding(get: { enabled && control.leader != nil }, set: { if !$0 { control.cancelStart() } }),
            titleVisibility: .visible) {
                if let leader = control.leader {
                    Button(L.t("epic_supersede_requeue", String(leader))) { control.confirm(requeue: true) }
                    Button(L.t("epic_supersede_now"), role: .destructive) { control.confirm(requeue: false) }
                }
                Button(L.t("common_cancel"), role: .cancel) { control.cancelStart() }
            } message: {
                Text(verbatim: L.t("native_ios_epic_supersede_message", String(control.leader ?? 0)))
            }
    }
}

enum IOSEpicControlCopy {
    static func action(_ action: IOSEpicPolicy.Action) -> String {
        switch action {
        case .pause: L.t("epic_pause")
        case .resume: L.t("native_ios_epic_resume")
        case .approve: L.t("native_ios_epic_approve")
        }
    }
}
