import ShepherdAppCore
import SwiftUI

struct IOSTerminalInputBar: View {
    let model: IOSTerminalPresentation
    var rendersStaticFixture = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                keyButton(.escape)
                if rendersStaticFixture {
                    GeometryReader { geometry in
                        scrollingKeys.fixedSize(horizontal: true, vertical: false)
                            .frame(width: geometry.size.width, alignment: .leading).clipped()
                    }.frame(height: 44)
                } else {
                    ScrollView(.horizontal) { scrollingKeys }.scrollIndicators(.hidden)
                }
                keyButton(.enter)
            }
            .disabled(!model.canSendInput)
            .padding(.horizontal, 10).padding(.bottom, 6)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L.t("controlbar_toolbar_aria"))
        }
        .font(.system(.callout, design: .monospaced))
        .background(IOSTerminalStyle.panel)
    }

    private var scrollingKeys: some View {
        HStack(spacing: 6) {
            ForEach(IOSTerminalKey.allCases.filter { $0 != .escape && $0 != .enter }, id: \.self) {
                keyButton($0)
            }
        }
    }

    private func keyButton(_ key: IOSTerminalKey) -> some View {
        Button { model.sendKey(key) } label: {
            Text(verbatim: key.keycap).fixedSize()
                .frame(minWidth: 44, minHeight: 44)
                .foregroundStyle(key == .enter ? IOSTerminalStyle.amber : IOSTerminalStyle.ink)
                .overlay(Rectangle().stroke(IOSTerminalStyle.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key.accessibilityLabel)
        .accessibilityIdentifier("terminal-key-\(key)")
    }
}
