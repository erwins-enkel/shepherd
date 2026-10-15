import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// "BRAUCHT → STUFE s/S → GIBT FREI" under an epic member's card: the web's
/// "Braucht zuerst → Dieses Issue → Gibt frei", condensed to one strip.
struct IOSEpicChainStrip: View {
    let chain: EpicChain

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            column(L.t("native_ios_epic_needs")) { needs }
                .frame(maxWidth: .infinity, alignment: .leading)
            arrow
            column(L.t("native_ios_epic_stage", String(chain.stage), String(chain.stageCount)),
                   tint: SessionListStyle.blue) {
                Text(verbatim: "#\(chain.number)").fontWeight(.semibold).foregroundStyle(SessionListStyle.bright)
            }
            .fixedSize()
            arrow
            column(L.t("childrun_step_unlocks")) { unlocks }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
        }
        .padding(.top, 8)
        .overlay(alignment: .top) {
            HLine().stroke(SessionListStyle.epicRail, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(height: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: Self.accessibilityText(chain)))
        .accessibilityIdentifier("epic-chain-\(chain.number)")
    }

    private var arrow: some View {
        Image(systemName: "arrow.right").sessionFont(label: true)
            .foregroundStyle(SessionListStyle.blue).padding(.top, 14).accessibilityHidden(true)
    }

    private func column<Content: View>(_ label: String, tint: Color = SessionListStyle.muted,
                                       @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: label.uppercased()).sessionFont(label: true, weight: .medium).tracking(0.8)
                .foregroundStyle(tint).lineLimit(1)
            content().sessionFont(label: true)
        }
    }

    @ViewBuilder private var needs: some View {
        let open = chain.needs.filter { !$0.merged }.map(\.number)
        if chain.needs.isEmpty {
            Text(verbatim: L.t("native_ios_epic_needs_none")).foregroundStyle(SessionListStyle.muted)
        } else if !open.isEmpty {
            // Started out of order: a blocker is still open.
            Label { Text(verbatim: L.t("native_ios_epic_need_open", EpicText.numbers(open))) }
                icon: { Image(systemName: "exclamationmark.triangle") }
                .labelStyle(.titleAndIcon).foregroundStyle(SessionListStyle.amber)
        } else {
            Text(verbatim: EpicText.numbers(chain.needs.map(\.number), prefix: "✓ ")).foregroundStyle(SessionListStyle.muted)
        }
    }

    @ViewBuilder private var unlocks: some View {
        if chain.unlocks.isEmpty {
            Text(verbatim: L.t("native_ios_epic_unlocks_none")).foregroundStyle(SessionListStyle.muted)
            if chain.isLast {
                Text(verbatim: L.t("native_ios_epic_lands_next")).foregroundStyle(SessionListStyle.muted)
            }
        } else {
            Text(verbatim: EpicText.numbers(chain.unlocks)).foregroundStyle(SessionListStyle.ink)
            if chain.parallel >= 2 {
                Text(verbatim: L.t("native_ios_epic_parallel", String(chain.parallel))).foregroundStyle(SessionListStyle.muted)
            }
        }
    }

    static func accessibilityText(_ chain: EpicChain) -> String {
        let needs = chain.needs.isEmpty ? L.t("native_ios_epic_needs_none")
            : chain.needs.map { $0.merged ? "✓ #\($0.number)" : L.t("native_ios_epic_need_open", "#\($0.number)") }
                .joined(separator: ", ")
        var unlocks = chain.unlocks.isEmpty ? L.t("native_ios_epic_unlocks_none")
            : chain.unlocks.map { "#\($0)" }.joined(separator: ", ")
        if chain.parallel >= 2 { unlocks += ", " + L.t("native_ios_epic_parallel", String(chain.parallel)) }
        return L.t("native_ios_epic_chain_aria", needs, String(chain.stage), String(chain.stageCount),
            String(chain.number), unlocks)
    }
}

private struct HLine: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}
