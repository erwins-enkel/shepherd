import AppKit
import ShepherdAppCore
import SwiftUI

struct ModeTabs: View {
    @Bindable var model: ComposeModel

    static func caption(_ mode: ComposeMode) -> String {
        switch mode {
        case .code: L.t("native_compose_code_caption")
        case .research: L.t("tooltip_mode_research_summary")
        case .epic: L.t("tooltip_mode_epic_summary")
        case .plain: L.t("tooltip_mode_plain_summary")
        }
    }
    static func hint(_ mode: ComposeMode) -> String {
        guard mode != .code else { return caption(mode) }
        let sections: [(StaticString, StaticString)]
        let title: StaticString
        switch mode {
        case .code: return caption(mode)
        case .research:
            title = "tooltip_mode_research_title"
            sections = [("tooltip_mode_research_output", "tooltip_mode_research_output_body"),
                        ("tooltip_mode_research_guards", "tooltip_mode_research_guards_body")]
        case .epic:
            title = "tooltip_mode_epic_title"
            sections = [("tooltip_mode_epic_draft", "tooltip_mode_epic_draft_body"),
                        ("tooltip_mode_epic_github", "tooltip_mode_epic_github_body")]
        case .plain:
            title = "tooltip_mode_plain_title"
            sections = [("tooltip_mode_plain_kept", "tooltip_mode_plain_kept_body"),
                        ("tooltip_mode_plain_dropped", "tooltip_mode_plain_dropped_body")]
        }
        return ([L.t(title), caption(mode)] + sections.map { "\(L.t($0.0)): \(L.t($0.1))" }).joined(separator: "\n\n")
    }

    var body: some View {
        ModeSegments(selection: Binding(get: { model.mode }, set: { model.setMode($0) }))
            .frame(height: 24)
            .accessibilityLabel(L.t("newtask_group_mode"))
            .accessibilityIdentifier("compose.mode")
    }
}

/// AppKit exposes a tooltip per segment; SwiftUI Picker's help applies to the entire control.
private struct ModeSegments: NSViewRepresentable {
    @Binding var selection: ComposeMode
    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }
    func makeNSView(context: Context) -> NSSegmentedControl {
        let control = NSSegmentedControl(labels: ComposeMode.allCases.map(\.title), trackingMode: .selectOne,
                                         target: context.coordinator, action: #selector(Coordinator.pick(_:)))
        control.segmentStyle = .rounded
        for (index, mode) in ComposeMode.allCases.enumerated() {
            control.setToolTip(ModeTabs.hint(mode), forSegment: index)
            control.setWidth(0, forSegment: index)
        }
        return control
    }
    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        context.coordinator.selection = $selection
        control.selectedSegment = ComposeMode.allCases.firstIndex(of: selection)!
        control.isEnabled = context.environment.isEnabled
    }
    @MainActor final class Coordinator: NSObject {
        var selection: Binding<ComposeMode>
        init(selection: Binding<ComposeMode>) { self.selection = selection }
        @objc func pick(_ control: NSSegmentedControl) {
            guard ComposeMode.allCases.indices.contains(control.selectedSegment) else { return }
            selection.wrappedValue = ComposeMode.allCases[control.selectedSegment]
        }
    }
}
