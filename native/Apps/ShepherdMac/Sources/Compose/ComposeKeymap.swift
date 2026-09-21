import ShepherdAppCore
import SwiftUI

private struct ComposeRevealKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var composeReveal: Bool {
        get { self[ComposeRevealKey.self] }
        set { self[ComposeRevealKey.self] = newValue }
    }
}
private struct ComposeEditingKey: FocusedValueKey { typealias Value = Bool }
extension FocusedValues {
    var composeEditingText: Bool? {
        get { self[ComposeEditingKey.self] }
        set { self[ComposeEditingKey.self] = newValue }
    }
}
struct ComposeKeycap: ViewModifier {
    @Environment(\.composeReveal) private var reveal
    @Environment(\.isEnabled) private var isEnabled
    let ids: [String]
    func body(content: Content) -> some View {
        content.overlay(alignment: .topTrailing) {
            if reveal {
                HStack(spacing: 3) {
                    ForEach(ids, id: \.self) { id in
                        Text(verbatim: ComposeKeymap.entry(id).cap).font(.caption.bold().monospaced())
                            .padding(4).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 4))
                    }
                }.opacity(isEnabled ? 1 : 0.35).allowsHitTesting(false)
            }
        }
    }
}

struct ComposeKeyCard: View {
    let close: () -> Void
    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text(verbatim: L.t("keymap_sheet_title")).font(.headline)
                Spacer()
                Button(L.t("keymap_sheet_dismiss"), action: close).keyboardShortcut(.cancelAction)
            }
            ScrollView {
                ForEach(ComposeKeymap.entries) { entry in
                    HStack {
                        Text(verbatim: entry.cap).monospaced().frame(width: 60, alignment: .leading)
                        Text(verbatim: L.t(entry.label))
                        if entry.id == "dictate" { Text(verbatim: L.t("native_compose_dictation_deferred")) }
                        Spacer()
                    }.foregroundStyle(entry.id == "dictate" ? .secondary : .primary)
                }
            }
        }.padding().frame(width: 460, height: 560)
    }
}
