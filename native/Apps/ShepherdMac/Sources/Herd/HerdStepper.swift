import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// A passive row accessory: selection remains the containing row's action.
struct HerdStepperView: View {
    let info: StepperInfo

    init(info: StepperInfo) { self.info = info }

    init(session: Session, git: GitState?, verdict: ReviewVerdict?, reviewing: Bool) {
        info = HerdClassifier.deriveStage(session: session, git: git, verdict: verdict, reviewing: reviewing)
    }

    var body: some View {
        let model = HerdStepper(info: info)
        if let terminal = model.terminal {
            let tint: Color = terminal == .merged ? ShepherdPalette.green : ShepherdPalette.amber
            Text(verbatim: model.accessibilityLabel)
                .textCase(.uppercase)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .foregroundStyle(tint)
                .overlay { RoundedRectangle(cornerRadius: 3).stroke(tint, lineWidth: 1) }
                .accessibilityLabel(Text(verbatim: model.accessibilityLabel))
        } else {
            HStack(spacing: 4) {
                ForEach(model.segments) { segment in
                    Rectangle()
                        .fill(segment.isHollow ? .clear : ShepherdPalette.badgeTint(segment.color))
                        .frame(height: segment.height)
                        .overlay {
                            Rectangle().stroke(ShepherdPalette.badgeTint(segment.color), lineWidth: segment.outlineWidth)
                                .padding(segment.isHollow ? 0 : -1)
                        }
                        .help(segment.accessibilityLabel)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: model.accessibilityLabel))
            .accessibilityValue(Text(verbatim: model.segments.map(\.accessibilityLabel).joined(separator: ", ")))
        }
    }
}
