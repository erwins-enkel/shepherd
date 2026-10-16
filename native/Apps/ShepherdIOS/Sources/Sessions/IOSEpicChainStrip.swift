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
        if chain.needs.contains(where: { !$0.merged }) {
            Label { Text(verbatim: Self.needsText(chain, limit: 2)) }
                icon: { Image(systemName: "exclamationmark.triangle") }
                .labelStyle(.titleAndIcon).foregroundStyle(SessionListStyle.amber)
        } else {
            Text(verbatim: Self.needsText(chain, limit: 2)).foregroundStyle(SessionListStyle.muted)
        }
    }

    static func needsText(_ chain: EpicChain, limit: Int? = nil) -> String {
        guard !chain.needs.isEmpty else { return L.t("native_ios_epic_needs_none") }
        let shown = chain.needs.prefix(limit ?? chain.needs.count)
        let text = shown.map {
            $0.merged ? "✓ #\($0.number)" : L.t("native_ios_epic_need_open", "#\($0.number)")
        }.joined(separator: limit == nil ? ", " : " · ")
        let remaining = chain.needs.count - shown.count
        return remaining > 0 ? "\(text) +\(remaining)" : text
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
        let needs = needsText(chain)
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
