import ShepherdAppCore
import SwiftUI

/// Equal-width keycaps and whole-key pages keep the resting right edge complete.
struct IOSTerminalKeyPage {
    let count: Int
    let width: CGFloat
    init(available: CGFloat, keyWidth: CGFloat) {
        count = max(1, Int((available + 6) / (keyWidth + 6)))
        width = CGFloat(count) * (keyWidth + 6) - 6
    }
}

struct IOSTerminalInputBar: View {
    let model: IOSTerminalPresentation
    @ScaledMetric(relativeTo: .callout) private var labelSize: CGFloat = 16
    private var keyWidth: CGFloat { max(44, ceil(labelSize * 2.4)) }
    private var keyHeight: CGFloat { max(44, ceil(labelSize * 1.3 + 16)) }
    private let keys = IOSTerminalKey.allCases.filter { $0 != .escape && $0 != .enter }

    var body: some View {
        HStack(spacing: 6) {
            keyButton(.escape)
            GeometryReader { geometry in
                let page = IOSTerminalKeyPage(available: geometry.size.width, keyWidth: keyWidth)
                HStack(spacing: 0) {
                    ScrollView(.horizontal) {
                        HStack(spacing: 0) {
                            ForEach(0..<((keys.count + page.count - 1) / page.count), id: \.self) { index in
                                HStack(spacing: 6) {
                                    ForEach(Array(keys.dropFirst(index * page.count).prefix(page.count)), id: \.self) { keyButton($0) }
                                }.frame(width: page.width, alignment: .leading)
                            }
                        }.scrollTargetLayout()
                    }
                    .scrollIndicators(.hidden).scrollTargetBehavior(.paging)
                    .frame(width: page.width, height: keyHeight)
                    Spacer(minLength: 0)
                }
            }.frame(height: keyHeight)
            keyButton(.enter)
        }
        .disabled(!model.canSendInput)
        .padding(.horizontal, 10).padding(.bottom, 6)
        .font(.system(size: labelSize, design: .monospaced))
        .background(IOSTerminalStyle.panel)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("controlbar_toolbar_aria"))
    }

    private func keyButton(_ key: IOSTerminalKey) -> some View {
        Button { model.sendKey(key) } label: {
            Text(verbatim: key.keycap).fixedSize()
                .frame(width: keyWidth, height: keyHeight)
                .foregroundStyle(key == .enter ? IOSTerminalStyle.amber : IOSTerminalStyle.ink)
                .overlay(Rectangle().stroke(IOSTerminalStyle.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key.accessibilityLabel)
        .accessibilityIdentifier("terminal-key-\(key)")
    }
}
